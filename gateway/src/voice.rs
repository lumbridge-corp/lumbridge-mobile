//! The assistant and its voice. Nothing here logs or stores what the owner says or what the assistant answers:
//! errors mention a status or a service, never the text. The one thing kept on disk is the
//! id of the current conversation, so it continues across devices and restarts.
//!
//! - Brain: Hermes on the same box. One session (`X-Hermes-Session-Id`), history lives in Hermes.
//! - ASR: LUMBRIDGE_ASR_PRIMARY_URL, an OpenAI-style chat endpoint for a speech-language model (Nemotron Transcribe SALM,
//!   say), with the owner's vocabulary in the request (vocab.rs): it spells the owner's names right where plain models don't.
//!   If it fails, each of LUMBRIDGE_ASR_URL and LUMBRIDGE_ASR_FALLBACK_URL (`/v1/audio/transcriptions`) in turn. The owner's
//!   fixes are applied to the transcript whichever answered. See `PRIVATE_LANE`. None set: speech to text is off.
//! - TTS: LUMBRIDGE_TTS_URL (`/v1/audio/speech`), behind `synthesize` alone. Unset: speech is off.

use crate::{
    auth::{self, Device},
    vocab::Vocab,
    AppState,
};
use base64ct::{Base64, Encoding};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Sent as `X-Lane` with every ASR request. A speech service that can keep audio plus transcript for training (by a list of
/// capture lanes, say) must never have this lane on that list: it keeps the owner's speech out of capture even if the
/// server's address is later mapped to a lane. (`*` on such a list would defeat this.)
/// A speech service that already knows another name for this lane: build with `LUMBRIDGE_ASR_PRIVATE_LANE=<name>`.
const PRIVATE_LANE: &str = match option_env!("LUMBRIDGE_ASR_PRIVATE_LANE") {
    Some(lane) => lane,
    None => "private-no-capture",
};

/// 16 kHz mono PCM16 is 32 kB/s; the browser stops at 60 s of speech.
const MAX_WAV_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_CHAT_BYTES: usize = 64 * 1024;
const MAX_CHAT_CHARS: usize = 16_000;
pub(crate) const MAX_SPEAK_CHARS: usize = 2_000;
const MAX_SSE_LINE: usize = 1024 * 1024;
const HISTORY_LIMIT: usize = 200;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const SPEECH_TIMEOUT: Duration = Duration::from_secs(25);
const HERMES_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const HERMES_SHORT_TIMEOUT: Duration = Duration::from_secs(8);
/// Hermes sends a keepalive every 10 s, so this much silence means it's gone.
const CHAT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const CHAT_MAX_DURATION: Duration = Duration::from_secs(15 * 60);

/// What the primary ASR is told along with the clip. The SALM takes the audio where `<|audio|>` is. With LUMBRIDGE_OWNER_NAME
/// it also says who is speaking.
fn asr_instructions(terms: &[String]) -> String {
    let mut s = String::from("Transcribe this dictation verbatim with normal punctuation and capitalization.");
    if let Some(name) = crate::config::owner_name() {
        s.push_str(&format!(" The speaker is {name}."));
    }
    if !terms.is_empty() {
        s.push_str(" The speaker often says these names and technical terms; when you hear one, spell it exactly as written here: ");
        s.push_str(&terms.join(", "));
        s.push('.');
    }
    s.push_str(" Do not add, answer or summarize anything. Output only the transcript. <|audio|>");
    s
}

/// The chat request :8806 takes. Not `/v1/audio/transcriptions` with `prompt`: there that becomes a speech context,
/// which the SALM ignores.
fn primary_request(wav: &[u8], terms: &[String]) -> Value {
    json!({ "model": "salm", "messages": [{ "role": "user", "content": [
        { "type": "text", "text": asr_instructions(terms) },
        { "type": "input_audio", "input_audio": { "data": Base64::encode_string(wav), "format": "wav" } },
    ]}]})
}

/// Which service answered, for the log: host and port, never anything said.
fn service(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| Some(format!("{}:{}", u.host_str()?, u.port_or_known_default()?)))
        .unwrap_or_else(|| "asr".into())
}

/// Speech to text: `primary` (chat, with the owner's vocabulary; empty: off), then each of `fallbacks` (transcription API).
pub struct Asr {
    pub primary: String,
    pub fallbacks: Vec<String>,
    pub vocab: Vocab,
}

/// Added to the assistant's own prompt for this turn only (Hermes doesn't persist it). It's about the
/// medium, not its identity or powers. `LUMBRIDGE_ASSISTANT_HINT=` (empty) turns it off.
const SPOKEN_HINT: &str = "You are being talked to in the Lumbridge app, usually by voice, and your \
reply is read aloud sentence by sentence as you write it. Lead with the answer in a short first \
sentence, sound natural, and skip lists, tables and code unless you are asked for them.";

pub struct Voice {
    http: reqwest::Client,
    hermes_url: String,
    hermes_key: Option<String>,
    hint: String,
    asr: Asr,
    tts_url: String,
    voice: String,
    session_file: PathBuf,
    session: Mutex<String>,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

/// `LUMBRIDGE_HERMES_KEY_FILE` is either Hermes's own `.env` or a file holding only the key.
fn parse_key(contents: &str) -> Option<String> {
    let key = contents
        .lines()
        .find_map(|l| l.trim().strip_prefix("API_SERVER_KEY="))
        .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .or_else(|| {
            let whole = contents.trim();
            (!whole.is_empty() && !whole.contains(['\n', '=', ' '])).then(|| whole.to_string())
        })?;
    (!key.is_empty()).then_some(key)
}

/// Magpie's voice must be selected by index: the names baked into this GGUF are in the wrong order.
fn voice_index(name: &str) -> Option<&'static str> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "0" | "aria" => "0",
        "1" | "jason" => "1",
        "2" | "john" => "2",
        "3" | "leo" => "3",
        "4" | "sofia" => "4",
        _ => return None,
    })
}

fn new_session_id() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("lumbridge_{ms}")
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl Voice {
    pub fn from_env(state_dir: &str) -> Self {
        // A dev build must name its Hermes: a local :8642 on a development machine may be another assistant.
        let dev = cfg!(feature = "dev-identity");
        let hermes_url = env_or("LUMBRIDGE_HERMES_URL", if dev { "" } else { "http://127.0.0.1:8642" });
        let default_key = if dev { String::new() } else { format!("{}/.hermes/.env", env_or("HOME", "")) };
        let key_file = env_or("LUMBRIDGE_HERMES_KEY_FILE", &default_key);
        let hermes_key = std::fs::read_to_string(&key_file).ok().and_then(|c| parse_key(&c));
        if hermes_key.is_none() {
            eprintln!("no Hermes key found: the assistant is unavailable, the rest of the app is fine");
        }
        let fallbacks = [env_or("LUMBRIDGE_ASR_URL", ""), env_or("LUMBRIDGE_ASR_FALLBACK_URL", "")];
        let asr = Asr {
            primary: env_or("LUMBRIDGE_ASR_PRIMARY_URL", ""),
            fallbacks: fallbacks.into_iter().filter(|u| !u.is_empty()).collect(),
            vocab: Vocab::new(env_or("LUMBRIDGE_VOICE_VOCAB_DIR", &format!("{}/.local/share/lumbridge/vocab", env_or("HOME", ""))).into()),
        };
        let configured = env_or("LUMBRIDGE_VOICE", "0");
        let voice = voice_index(&configured).unwrap_or_else(|| {
            eprintln!("LUMBRIDGE_VOICE must be 0-4 or aria/jason/john/leo/sofia; using 0");
            "0"
        });
        Self::new(
            hermes_url,
            hermes_key,
            asr,
            env_or("LUMBRIDGE_TTS_URL", ""),
            voice.to_string(),
            env_or("LUMBRIDGE_ASSISTANT_HINT", SPOKEN_HINT),
            state_dir,
        )
    }

    fn new(
        hermes_url: String,
        hermes_key: Option<String>,
        asr: Asr,
        tts_url: String,
        voice: String,
        hint: String,
        state_dir: &str,
    ) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .no_proxy()
            .build()
            .expect("http client");
        let session_file = PathBuf::from(state_dir).join("assistant-session");
        let session = std::fs::read_to_string(&session_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| valid_session_id(s))
            .unwrap_or_default();
        Self {
            http,
            hermes_url: hermes_url.trim_end_matches('/').to_string(),
            hermes_key,
            hint,
            asr,
            tts_url,
            voice,
            session_file,
            session: Mutex::new(session),
        }
    }

    fn set_session(&self, id: String) -> String {
        // Written atomically; on failure the conversation still works until the next restart.
        let tmp = self.session_file.with_extension("tmp");
        if std::fs::write(&tmp, &id).and_then(|_| std::fs::rename(&tmp, &self.session_file)).is_err() {
            eprintln!("could not save the assistant's session id");
        }
        *self.session.lock().unwrap() = id.clone();
        id
    }

    /// The conversation, which every device shares. Hermes creates the session on its first turn.
    fn session(&self) -> String {
        let current = self.session.lock().unwrap().clone();
        if current.is_empty() {
            self.set_session(new_session_id())
        } else {
            current
        }
    }

    fn hermes(&self) -> Result<(&str, &str), ApiError> {
        match (self.hermes_url.as_str(), self.hermes_key.as_deref()) {
            ("", _) | (_, None) => Err(ApiError::assistant_unreachable()),
            (url, Some(key)) => Ok((url, key)),
        }
    }

    /// Text to WAV. The only function that knows which voice the assistant has.
    async fn synthesize(&self, text: &str) -> Result<Bytes, SpeechError> {
        let body = json!({ "input": text, "voice": self.voice, "response_format": "wav" });
        let res = self
            .http
            .post(&self.tts_url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .timeout(SPEECH_TIMEOUT)
            .send()
            .await
            .map_err(|_| SpeechError)?;
        if !res.status().is_success() {
            eprintln!("tts upstream status {}", res.status().as_u16());
            return Err(SpeechError);
        }
        res.bytes().await.map_err(|_| SpeechError)
    }

    /// WAV to text, trying each ASR in turn, with the owner's fixes applied.
    async fn recognize(&self, wav: Bytes) -> Result<String, SpeechError> {
        let vocab = self.asr.vocab.current();
        if !self.asr.primary.is_empty() {
            if let Some(text) = self.recognize_primary(&wav, &vocab.terms).await {
                eprintln!("asr by {}", service(&self.asr.primary));
                return Ok(vocab.apply(&text));
            }
        }
        let text = self.recognize_fallback(wav).await?;
        Ok(vocab.apply(&text))
    }

    /// :8806 with the owner's vocabulary. None when it can't be reached, says no, or hears nothing.
    async fn recognize_primary(&self, wav: &[u8], terms: &[String]) -> Option<String> {
        let sent = self
            .http
            .post(&self.asr.primary)
            .header("X-Lane", PRIVATE_LANE)
            .header(header::CONTENT_TYPE, "application/json")
            .body(primary_request(wav, terms).to_string())
            .timeout(SPEECH_TIMEOUT)
            .send()
            .await;
        let res = match sent {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                eprintln!("asr primary status {}", r.status().as_u16());
                return None;
            }
            Err(_) => {
                eprintln!("asr primary unreachable");
                return None;
            }
        };
        let parsed: Option<Value> = res.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok());
        match parsed.as_ref().and_then(|v| v["choices"][0]["message"]["content"].as_str()).map(str::trim) {
            Some(text) if !text.is_empty() => Some(text.to_string()),
            Some(_) => {
                eprintln!("asr primary heard nothing");
                None
            }
            None => {
                eprintln!("asr primary sent an unreadable reply");
                None
            }
        }
    }

    /// The transcription API at each fallback in turn.
    async fn recognize_fallback(&self, wav: Bytes) -> Result<String, SpeechError> {
        for url in &self.asr.fallbacks {
            let part = reqwest::multipart::Part::stream(wav.clone())
                .file_name("speech.wav")
                .mime_str("audio/wav")
                .map_err(|_| SpeechError)?;
            let form = reqwest::multipart::Form::new().part("file", part).text("response_format", "json");
            let sent = self
                .http
                .post(url)
                .header("X-Lane", PRIVATE_LANE)
                .multipart(form)
                .timeout(SPEECH_TIMEOUT)
                .send()
                .await;
            let res = match sent {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    eprintln!("asr upstream status {}", r.status().as_u16());
                    continue;
                }
                Err(_) => {
                    eprintln!("asr upstream unreachable");
                    continue;
                }
            };
            let parsed: Option<Value> = res.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok());
            if let Some(text) = parsed.as_ref().and_then(|v| v["text"].as_str()) {
                eprintln!("asr by {}", service(url));
                return Ok(text.trim().to_string());
            }
            eprintln!("asr upstream sent an unreadable reply");
        }
        Err(SpeechError)
    }
}

struct SpeechError;

/// A failure the app can tell apart: `error` is a stable code, never upstream text.
pub(crate) struct ApiError(pub(crate) StatusCode, pub(crate) &'static str);

impl ApiError {
    fn assistant_unreachable() -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, "assistant_unreachable")
    }
    fn voice_offline() -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, "voice_offline")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "error": self.1 }))).into_response()
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/assistant/chat", post(chat).layer(DefaultBodyLimit::max(MAX_CHAT_BYTES)))
        .route("/api/assistant/history", get(history))
        .route("/api/assistant/status", get(status))
        .route("/api/assistant/new", post(new_conversation))
        .route("/api/voice/transcribe", post(transcribe).layer(DefaultBodyLimit::max(MAX_WAV_BYTES)))
        .route("/api/voice/speak", post(speak).layer(DefaultBodyLimit::max(MAX_CHAT_BYTES)))
}

pub(crate) fn text_field(body: &Value, max_chars: usize) -> Result<&str, ApiError> {
    let text = body["text"].as_str().map(str::trim).unwrap_or("");
    if text.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "empty"));
    }
    if text.chars().count() > max_chars {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "too_long"));
    }
    Ok(text)
}

async fn chat(_: Device, State(s): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    // Revoking a device ends its open streams too. That closes the upstream request, so Hermes stops as well.
    let token = auth::bearer(&headers).unwrap_or("").to_string();
    let state = s.clone();
    let revoked = Box::pin(async move { auth::until_revoked(&state, &token).await });
    match open_chat(&s.voice, &body).await {
        Ok(upstream) => Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Accel-Buffering", "no")
            .body(Body::from_stream(relay(upstream).take_until(revoked).map(Ok::<Bytes, std::convert::Infallible>)))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(e) => e.into_response(),
    }
}

async fn open_chat(v: &Voice, body: &Value) -> Result<reqwest::Response, ApiError> {
    let text = text_field(body, MAX_CHAT_CHARS)?;
    let (url, key) = v.hermes()?;
    let mut messages = Vec::new();
    if !v.hint.is_empty() {
        messages.push(json!({ "role": "system", "content": v.hint }));
    }
    messages.push(json!({ "role": "user", "content": text }));
    // With X-Hermes-Session-Id the history comes from Hermes, so only the new turn is sent.
    // No overall timeout here: the relay bounds the stream, and dropping it closes this request,
    // which Hermes treats as a disconnect and interrupts the agent.
    let res = tokio::time::timeout(
        HERMES_OPEN_TIMEOUT,
        v.http
            .post(format!("{url}/v1/chat/completions"))
            .bearer_auth(key)
            .header("X-Hermes-Session-Id", v.session())
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({ "model": "hermes-agent", "stream": true, "messages": messages }).to_string())
            .send(),
    )
    .await
    .map_err(|_| ApiError::assistant_unreachable())?
    .map_err(|_| ApiError::assistant_unreachable())?;
    if !res.status().is_success() {
        eprintln!("hermes status {}", res.status().as_u16());
        return Err(ApiError(StatusCode::BAD_GATEWAY, "assistant_error"));
    }
    Ok(res)
}

/// One turn for the assistant that nobody is waiting to hear: an answer to one of its asks (data/asks.rs). Sent the way `open_chat` sends
/// the owner's, in the same session, without the spoken hint. Ok once Hermes has taken it. Her reply is then read to the end and dropped,
/// because closing the stream early would interrupt her; it shows in the conversation's history like any other.
pub async fn tell(v: &Voice, text: &str) -> Result<(), ()> {
    let (url, key) = v.hermes().map_err(|_| ())?;
    let messages = [json!({ "role": "user", "content": text })];
    let res = tokio::time::timeout(
        HERMES_OPEN_TIMEOUT,
        v.http
            .post(format!("{url}/v1/chat/completions"))
            .bearer_auth(key)
            .header("X-Hermes-Session-Id", v.session())
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({ "model": "hermes-agent", "stream": true, "messages": messages }).to_string())
            .send(),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if !res.status().is_success() {
        eprintln!("hermes status {} for an answer", res.status().as_u16());
        return Err(());
    }
    tokio::spawn(async move {
        let mut body = res.bytes_stream();
        let _ = tokio::time::timeout(CHAT_MAX_DURATION, async { while let Some(Ok(_)) = body.next().await {} }).await;
    });
    Ok(())
}

/// Splits an SSE byte stream into events, across chunk boundaries (including inside a UTF-8 char).
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: String,
}

#[derive(Debug, PartialEq)]
enum SseItem {
    Comment,
    Event { event: String, data: String },
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseItem>, ()> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() || !self.event.is_empty() {
                    out.push(SseItem::Event { event: std::mem::take(&mut self.event), data: std::mem::take(&mut self.data) });
                }
            } else if line.starts_with(':') {
                out.push(SseItem::Comment);
            } else if let Some(v) = line.strip_prefix("event:") {
                self.event = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(v.strip_prefix(' ').unwrap_or(v));
            }
        }
        if self.buf.len() > MAX_SSE_LINE || self.data.len() > MAX_SSE_LINE {
            return Err(());
        }
        Ok(out)
    }
}

fn frame(event: &str, data: Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

/// What the app sees of one Hermes event. Reasoning is deliberately not passed on.
fn translate(item: SseItem) -> Vec<Translated> {
    let (event, data) = match item {
        SseItem::Comment => return vec![Translated::Frame(Bytes::from_static(b": keepalive\n\n"))],
        SseItem::Event { event, data } => (event, data),
    };
    match event.as_str() {
        "hermes.tool.progress" => {
            let Ok(v) = serde_json::from_str::<Value>(&data) else { return vec![] };
            vec![Translated::Frame(frame(
                "tool",
                json!({ "tool": v["tool"], "status": v["status"], "id": v["toolCallId"] }),
            ))]
        }
        "" | "message" => {
            if data.trim() == "[DONE]" {
                return vec![Translated::End];
            }
            let Ok(v) = serde_json::from_str::<Value>(&data) else { return vec![] };
            let choice = &v["choices"][0];
            let mut out = Vec::new();
            if let Some(text) = choice["delta"]["content"].as_str().filter(|t| !t.is_empty()) {
                out.push(Translated::Frame(frame("delta", json!({ "text": text }))));
            }
            match choice["finish_reason"].as_str() {
                None | Some("stop") => {}
                Some("length") => out.push(Translated::Frame(frame("notice", json!({ "code": "cut_short" })))),
                Some(_) => out.push(Translated::Failed),
            }
            out
        }
        _ => vec![],
    }
}

enum Translated {
    Frame(Bytes),
    End,
    Failed,
}

struct Relay {
    upstream: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    parser: SseParser,
    ready: VecDeque<Bytes>,
    deadline: Instant,
    finished: bool,
}

impl Relay {
    fn finish(&mut self, last: Bytes) {
        self.ready.push_back(last);
        self.finished = true;
    }
}

/// Hermes's stream as the app's small event set: `delta`, `tool`, `notice`, then `done` or `error`.
/// When the client goes away the stream is dropped, which closes the upstream request.
fn relay(res: reqwest::Response) -> impl Stream<Item = Bytes> + Send {
    let state = Relay {
        upstream: Box::pin(res.bytes_stream()),
        parser: SseParser::default(),
        ready: VecDeque::new(),
        deadline: Instant::now() + CHAT_MAX_DURATION,
        finished: false,
    };
    stream::unfold(state, |mut st| async move {
        loop {
            if let Some(b) = st.ready.pop_front() {
                return Some((b, st));
            }
            if st.finished {
                return None;
            }
            let wait = CHAT_IDLE_TIMEOUT.min(st.deadline.saturating_duration_since(Instant::now()));
            match tokio::time::timeout(wait, st.upstream.next()).await {
                Err(_) => st.finish(frame("error", json!({ "code": "assistant_timeout" }))),
                Ok(None) | Ok(Some(Err(_))) => st.finish(frame("error", json!({ "code": "assistant_interrupted" }))),
                Ok(Some(Ok(chunk))) => match st.parser.push(&chunk) {
                    Err(()) => st.finish(frame("error", json!({ "code": "assistant_error" }))),
                    Ok(items) => {
                        for item in items {
                            for t in translate(item) {
                                match t {
                                    Translated::Frame(b) => st.ready.push_back(b),
                                    Translated::End => st.finish(frame("done", json!({}))),
                                    Translated::Failed => st.finish(frame("error", json!({ "code": "assistant_error" }))),
                                }
                            }
                            if st.finished {
                                break;
                            }
                        }
                    }
                },
            }
        }
    })
}

/// Hermes rows as the conversation the owner saw: their messages and the assistant's words, no tool or meta rows.
fn normalize_history(body: &Value) -> Vec<Value> {
    let empty = Vec::new();
    body["data"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant")))
        .filter_map(|m| {
            let text = m["content"].as_str()?.trim();
            (!text.is_empty()).then(|| json!({ "role": m["role"], "text": text, "ts": m["timestamp"] }))
        })
        .collect()
}

/// Whether Hermes answers, always as 200, so the page can wait for her to come back without a failed request each time
/// (a browser logs every one of those as an error). Answering at all counts, as for history: a session with no turn yet is 404.
async fn status(_: Device, State(s): State<Arc<AppState>>) -> Response {
    let v = &s.voice;
    let reachable = match v.hermes() {
        Err(_) => false,
        Ok((url, key)) => {
            let session = v.session();
            let res = v
                .http
                .get(format!("{url}/api/sessions/{session}/messages?limit=1&order=latest"))
                .bearer_auth(key)
                .timeout(HERMES_SHORT_TIMEOUT)
                .send()
                .await;
            matches!(res, Ok(r) if r.status().is_success() || r.status() == StatusCode::NOT_FOUND)
        }
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "reachable": reachable }))).into_response()
}

async fn history(_: Device, State(s): State<Arc<AppState>>) -> Response {
    let v = &s.voice;
    let (url, key) = match v.hermes() {
        Ok(x) => x,
        Err(e) => return e.into_response(),
    };
    let session = v.session();
    let res = v
        .http
        .get(format!("{url}/api/sessions/{session}/messages?limit={HISTORY_LIMIT}&order=latest"))
        .bearer_auth(key)
        .timeout(HERMES_SHORT_TIMEOUT)
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(_) => return ApiError::assistant_unreachable().into_response(),
    };
    let messages = match res.status() {
        // A session that has had no turn yet doesn't exist in Hermes.
        StatusCode::NOT_FOUND => Vec::new(),
        st if st.is_success() => match res.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(body) => normalize_history(&body),
            None => return ApiError(StatusCode::BAD_GATEWAY, "assistant_error").into_response(),
        },
        st => {
            eprintln!("hermes history status {}", st.as_u16());
            return ApiError(StatusCode::BAD_GATEWAY, "assistant_error").into_response();
        }
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "messages": messages }))).into_response()
}

/// Starts a fresh conversation for every device. The old one stays in Hermes.
async fn new_conversation(_: Device, State(s): State<Arc<AppState>>) -> Response {
    s.voice.set_session(new_session_id());
    Json(json!({ "ok": true })).into_response()
}

fn looks_like_wav(b: &[u8]) -> bool {
    b.len() > 44 && &b[..4] == b"RIFF" && &b[8..12] == b"WAVE"
}

async fn transcribe(_: Device, State(s): State<Arc<AppState>>, wav: Bytes) -> Response {
    if !looks_like_wav(&wav) {
        return ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_wav").into_response();
    }
    match s.voice.recognize(wav).await {
        Ok(text) => ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "text": text }))).into_response(),
        Err(SpeechError) => ApiError::voice_offline().into_response(),
    }
}

async fn speak(_: Device, State(s): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let text = match text_field(&body, MAX_SPEAK_CHARS) {
        Ok(t) => t,
        Err(e) => return e.into_response(),
    };
    match s.voice.synthesize(text).await {
        Ok(wav) => ([(header::CONTENT_TYPE, "audio/wav"), (header::CACHE_CONTROL, "no-store")], wav).into_response(),
        Err(SpeechError) => ApiError::voice_offline().into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicBool, Ordering};

    const TOKEN: &str = "test-token-test-token-test-token-test";
    const LOGIN: &str = "sam@example.com";

    /// Authorization, X-Hermes-Session-Id and body of one request to Hermes.
    type HermesCall = (Option<String>, Option<String>, Value);

    #[derive(Default)]
    struct Seen {
        hermes: Mutex<Vec<HermesCall>>,
        lanes: Mutex<Vec<(String, Option<String>)>>,
        /// Which :8806 stand-in got a request, and the request.
        primary: Mutex<Vec<(String, Value)>>,
        tts: Mutex<Vec<Value>>,
    }

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    const SCRIPT: &str = concat!(
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"SECRET THOUGHT\"}}]}\n\n",
        ": keepalive\n\n",
        "event: hermes.tool.progress\ndata: {\"tool\":\"fleet_health\",\"emoji\":\"x\",\"label\":\"l\",\"toolCallId\":\"c1\",\"status\":\"running\"}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Héllo \"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"there.\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );

    #[derive(Clone)]
    struct Fake {
        seen: Arc<Seen>,
        hang_dropped: Arc<AtomicBool>,
        hang: bool,
    }

    async fn fake_chat(State(f): State<Fake>, headers: axum::http::HeaderMap, Json(body): Json<Value>) -> Response {
        let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(String::from);
        f.seen.hermes.lock().unwrap().push((h("authorization"), h("x-hermes-session-id"), body));
        if f.hang {
            // Sends one delta, then keeps the connection open until the client goes away.
            let guard = DropFlag(f.hang_dropped.clone());
            let s = stream::unfold((0, guard), |(i, g)| async move {
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    return Some((Ok::<_, std::convert::Infallible>(Bytes::from_static(b": keepalive\n\n")), (i + 1, g)));
                }
                Some((Ok(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n")), (i + 1, g)))
            });
            return Body::from_stream(s).into_response();
        }
        // One byte at a time, so a UTF-8 char and every SSE line straddle chunks.
        let bytes: Vec<Result<Bytes, std::convert::Infallible>> =
            SCRIPT.as_bytes().iter().map(|b| Ok(Bytes::copy_from_slice(&[*b]))).collect();
        Body::from_stream(stream::iter(bytes)).into_response()
    }

    async fn fake_messages(axum::extract::Path(id): axum::extract::Path<String>) -> Response {
        if id.contains("missing") {
            return StatusCode::NOT_FOUND.into_response();
        }
        Json(json!({ "data": [
            { "role": "user", "content": "hi", "timestamp": 1.0 },
            { "role": "assistant", "content": "", "tool_calls": [{}], "timestamp": 2.0 },
            { "role": "tool", "content": "tool output", "timestamp": 3.0 },
            { "role": "assistant", "content": "hello", "timestamp": 4.0 },
            { "role": "session_meta", "content": null, "timestamp": 5.0 },
        ]}))
        .into_response()
    }

    async fn fake_asr_ok(State(f): State<Fake>, headers: axum::http::HeaderMap) -> Response {
        let lane = headers.get("x-lane").and_then(|v| v.to_str().ok()).map(String::from);
        f.seen.lanes.lock().unwrap().push(("ok".into(), lane));
        Json(json!({ "text": " hello assistant " })).into_response()
    }

    async fn fake_asr_bad(State(f): State<Fake>, headers: axum::http::HeaderMap) -> Response {
        let lane = headers.get("x-lane").and_then(|v| v.to_str().ok()).map(String::from);
        f.seen.lanes.lock().unwrap().push(("bad".into(), lane));
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }

    /// :8806: `ok` answers as the SALM does, `empty` hears nothing, `bad` fails.
    async fn fake_primary(State(f): State<Fake>, axum::extract::Path(kind): axum::extract::Path<String>, Json(body): Json<Value>) -> Response {
        f.seen.primary.lock().unwrap().push((kind.clone(), body));
        match kind.as_str() {
            "ok" => Json(json!({ "choices": [{ "message": { "role": "assistant", "content": " Open desk flow on GPU one. " } }] })).into_response(),
            "empty" => Json(json!({ "choices": [{ "message": { "role": "assistant", "content": "  " } }] })).into_response(),
            _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }

    async fn fake_tts(State(f): State<Fake>, Json(body): Json<Value>) -> Response {
        f.seen.tts.lock().unwrap().push(body);
        ([(header::CONTENT_TYPE, "audio/wav")], &b"RIFFxxxxWAVEfake"[..]).into_response()
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn dead_url() -> String {
        // Port 1: a test can't bind it, so nothing ever listens there. A port just released could be taken meanwhile by
        // another test's fake server running in parallel, which then answers 404 where "unreachable" was meant.
        "http://127.0.0.1:1".into()
    }

    struct Harness {
        url: String,
        seen: Arc<Seen>,
        hang_dropped: Arc<AtomicBool>,
        _dir: TempDir,
    }

    /// A temp dir without pulling in a crate for it.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let p = std::env::temp_dir().join(format!(
                "lumbridge-voice-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The one place tests build an `AppState`.
    fn app_state(voice: Voice, state_dir: &str) -> Arc<AppState> {
        let mut cfg = Config::for_tests(std::path::Path::new(state_dir));
        cfg.login = LOGIN.into();
        let mut state = AppState::new(cfg);
        state.voice = voice;
        state.auth.devices.add_token("test", TOKEN, crate::devices::Role::Owner).unwrap();
        Arc::new(state)
    }

    /// Everything over HTTP needs to get past tailnet admission, which only a dev-identity build skips.
    fn skip() -> bool {
        if !cfg!(feature = "dev-identity") {
            eprintln!("skipped: run with --features dev-identity");
        }
        !cfg!(feature = "dev-identity")
    }

    struct Opts {
        hang: bool,
        asr: Vec<&'static str>,
        /// :8806: `ok`, `empty`, `bad`, `dead`, or "" for none.
        primary: &'static str,
        /// What `LUMBRIDGE_VOICE_VOCAB_DIR` holds, by file name.
        vocab: Vec<(&'static str, Value)>,
        hermes_down: bool,
        tts_down: bool,
    }
    impl Default for Opts {
        fn default() -> Self {
            Self { hang: false, asr: vec!["ok"], primary: "", vocab: vec![], hermes_down: false, tts_down: false }
        }
    }

    async fn harness(o: Opts) -> Harness {
        let seen = Arc::new(Seen::default());
        let hang_dropped = Arc::new(AtomicBool::new(false));
        let fake = Fake { seen: seen.clone(), hang_dropped: hang_dropped.clone(), hang: o.hang };
        let upstream = serve(
            Router::new()
                .route("/v1/chat/completions", post(fake_chat))
                .route("/api/sessions/:id/messages", get(fake_messages))
                .route("/asr-ok", post(fake_asr_ok))
                .route("/asr-bad", post(fake_asr_bad))
                .route("/primary/:kind", post(fake_primary))
                .route("/tts", post(fake_tts))
                .with_state(fake),
        )
        .await;
        let asr = o
            .asr
            .iter()
            .map(|a| match *a {
                "ok" => format!("{upstream}/asr-ok"),
                "bad" => format!("{upstream}/asr-bad"),
                _ => dead_url(),
            })
            .collect();
        let dir = TempDir::new();
        let vocab_dir = PathBuf::from(dir.path()).join("vocab");
        std::fs::create_dir(&vocab_dir).unwrap();
        for (name, v) in &o.vocab {
            std::fs::write(vocab_dir.join(name), v.to_string()).unwrap();
        }
        let primary = match o.primary {
            "" => String::new(),
            "dead" => dead_url(),
            kind => format!("{upstream}/primary/{kind}"),
        };
        let voice = Voice::new(
            if o.hermes_down { dead_url() } else { upstream.clone() },
            Some("hermes-secret".into()),
            Asr { primary, fallbacks: asr, vocab: Vocab::new(vocab_dir) },
            if o.tts_down { dead_url() } else { format!("{upstream}/tts") },
            "4".into(),
            "hint".into(),
            dir.path(),
        );
        let url = serve(router().with_state(app_state(voice, dir.path()))).await;
        Harness { url, seen, hang_dropped, _dir: dir }
    }

    fn client(url: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        reqwest::Client::new()
            .request(method, format!("{url}{path}"))
            .bearer_auth(TOKEN)
            .header("tailscale-user-login", LOGIN)
    }

    fn post_json(url: &str, path: &str, body: Value) -> reqwest::RequestBuilder {
        client(url, reqwest::Method::POST, path).header("content-type", "application/json").body(body.to_string())
    }

    fn wav() -> Vec<u8> {
        let mut v = b"RIFF\0\0\0\0WAVE".to_vec();
        v.resize(100, 0);
        v
    }

    #[tokio::test]
    async fn every_endpoint_requires_the_device_token() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let c = reqwest::Client::new();
        for (m, p) in [
            (reqwest::Method::POST, "/api/assistant/chat"),
            (reqwest::Method::GET, "/api/assistant/history"),
            (reqwest::Method::GET, "/api/assistant/status"),
            (reqwest::Method::POST, "/api/assistant/new"),
            (reqwest::Method::POST, "/api/voice/transcribe"),
            (reqwest::Method::POST, "/api/voice/speak"),
        ] {
            let no_token = c.request(m.clone(), format!("{}{p}", h.url)).header("tailscale-user-login", LOGIN);
            assert_eq!(no_token.send().await.unwrap().status(), 401, "{p}");
            let bad = c
                .request(m, format!("{}{p}", h.url))
                .header("tailscale-user-login", LOGIN)
                .bearer_auth("wrong");
            assert_eq!(bad.send().await.unwrap().status(), 401, "{p}");
        }
        assert!(h.seen.hermes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn chat_streams_words_and_tools_but_never_reasoning() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let res = post_json(&h.url, "/api/assistant/chat", json!({ "text": " hello " })).send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "text/event-stream");
        let body = res.text().await.unwrap();
        assert!(!body.contains("SECRET"), "{body}");
        assert!(body.contains(r#"event: delta
data: {"text":"Héllo "}"#), "{body}");
        assert!(body.contains(r#"{"text":"there."}"#));
        assert!(body.contains(r#"event: tool
data: {"id":"c1","status":"running","tool":"fleet_health"}"#), "{body}");
        assert!(body.ends_with("event: done\ndata: {}\n\n"), "{body}");

        let seen = h.seen.hermes.lock().unwrap();
        let (auth, session, sent) = &seen[0];
        assert_eq!(auth.as_deref(), Some("Bearer hermes-secret"));
        assert!(session.as_deref().unwrap().starts_with("lumbridge_"));
        assert_eq!(sent["stream"], true);
        let msgs = sent["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "history comes from Hermes, only the new turn is sent");
        assert_eq!(msgs[0], json!({ "role": "system", "content": "hint" }));
        assert_eq!(msgs[1], json!({ "role": "user", "content": "hello" }));
    }

    #[tokio::test]
    async fn the_conversation_continues_until_new_and_survives_a_restart() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let send = || post_json(&h.url, "/api/assistant/chat", json!({ "text": "x" })).send();
        send().await.unwrap().text().await.unwrap();
        send().await.unwrap().text().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        let new = client(&h.url, reqwest::Method::POST, "/api/assistant/new").send().await.unwrap();
        assert_eq!(new.status(), 200);
        send().await.unwrap().text().await.unwrap();
        let ids: Vec<String> = h.seen.hermes.lock().unwrap().iter().map(|s| s.1.clone().unwrap()).collect();
        assert_eq!(ids[0], ids[1]);
        assert_ne!(ids[1], ids[2]);

        let asr = Asr { primary: String::new(), fallbacks: vec![], vocab: Vocab::new(PathBuf::new()) };
        let reloaded = Voice::new(String::new(), None, asr, String::new(), "0".into(), String::new(), h._dir.path());
        assert_eq!(reloaded.session(), ids[2]);
    }

    #[tokio::test]
    async fn a_client_disconnect_closes_the_upstream_request() {
        if skip() { return; }
        let h = harness(Opts { hang: true, ..Opts::default() }).await;
        let mut res = post_json(&h.url, "/api/assistant/chat", json!({ "text": "x" })).send().await.unwrap();
        let first = res.chunk().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&first).contains(r#"{"text":"Hi"}"#));
        assert!(!h.hang_dropped.load(Ordering::SeqCst));
        drop(res);
        for _ in 0..50 {
            if h.hang_dropped.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("upstream request stayed open after the client left");
    }

    #[tokio::test]
    async fn revoking_the_device_ends_an_open_stream_within_the_promised_5_seconds() {
        if skip() { return; }
        let h = harness(Opts { hang: true, ..Opts::default() }).await;
        let mut res = post_json(&h.url, "/api/assistant/chat", json!({ "text": "x" })).send().await.unwrap();
        res.chunk().await.unwrap().unwrap();
        // As the CLI does it: another process's store on the same file.
        assert!(crate::devices::Store::new(h._dir.path()).revoke("test").unwrap());
        let ended = tokio::time::timeout(Duration::from_millis(5500), async {
            while let Ok(Some(_)) = res.chunk().await {}
        })
        .await;
        assert!(ended.is_ok(), "the stream outlived the revoke by more than 5 s");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(h.hang_dropped.load(Ordering::SeqCst), "Hermes' request is closed too");
    }

    #[tokio::test]
    async fn chat_says_when_the_assistant_is_unreachable() {
        if skip() { return; }
        let h = harness(Opts { hermes_down: true, ..Opts::default() }).await;
        let res = post_json(&h.url, "/api/assistant/chat", json!({ "text": "x" })).send().await.unwrap();
        assert_eq!(res.status(), 503);
        assert_eq!(res.json_text().await["error"], "assistant_unreachable");
        let res = client(&h.url, reqwest::Method::GET, "/api/assistant/history").send().await.unwrap();
        assert_eq!(res.status(), 503);
        let res = client(&h.url, reqwest::Method::GET, "/api/assistant/status").send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.json_text().await["reachable"], false);
    }

    #[tokio::test]
    async fn status_says_when_the_assistant_answers() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let res = client(&h.url, reqwest::Method::GET, "/api/assistant/status").send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["cache-control"], "no-store");
        assert_eq!(res.json_text().await["reachable"], true);
    }

    #[tokio::test]
    async fn chat_refuses_bad_input() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let empty = post_json(&h.url, "/api/assistant/chat", json!({ "text": "   " })).send().await.unwrap();
        assert_eq!(empty.status(), 400);
        let long = "x".repeat(MAX_CHAT_CHARS + 1);
        let res = post_json(&h.url, "/api/assistant/chat", json!({ "text": long })).send().await.unwrap();
        assert_eq!(res.status(), 413);
        let huge = "x".repeat(MAX_CHAT_BYTES + 1);
        let res = post_json(&h.url, "/api/assistant/chat", json!({ "text": huge })).send().await.unwrap();
        assert_eq!(res.status(), 413);
        assert!(h.seen.hermes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn history_shows_only_the_conversation() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let res = client(&h.url, reqwest::Method::GET, "/api/assistant/history").send().await.unwrap();
        assert_eq!(res.status(), 200);
        let body = res.json_text().await;
        let got: Vec<(&str, &str)> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (m["role"].as_str().unwrap(), m["text"].as_str().unwrap()))
            .collect();
        assert_eq!(got, vec![("user", "hi"), ("assistant", "hello")]);
    }

    #[tokio::test]
    async fn transcribe_marks_the_private_lane_and_trims() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.json_text().await["text"], "hello assistant");
        let lanes = h.seen.lanes.lock().unwrap();
        assert_eq!(lanes[0].1.as_deref(), Some(PRIVATE_LANE));
    }

    #[tokio::test]
    async fn transcribe_falls_back_and_only_then_reports_voice_offline() {
        if skip() { return; }
        let h = harness(Opts { asr: vec!["bad", "ok"], ..Opts::default() }).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
        assert_eq!(res.status(), 200);
        let lanes = h.seen.lanes.lock().unwrap().clone();
        assert_eq!(lanes.iter().map(|l| l.0.as_str()).collect::<Vec<_>>(), ["bad", "ok"]);
        assert!(lanes.iter().all(|l| l.1.as_deref() == Some(PRIVATE_LANE)), "every attempt is private");

        let h = harness(Opts { asr: vec!["bad", "dead"], ..Opts::default() }).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
        assert_eq!(res.status(), 503);
        assert_eq!(res.json_text().await["error"], "voice_offline");
    }

    fn owner_vocab() -> Vec<(&'static str, Value)> {
        vec![
            ("vocab.json", json!({ "terms": ["gpu-box", "Deskflow"], "fixes": [["desk flow", "Deskflow"]] })),
            ("learned.json", json!({ "terms": ["postgres"] })),
            ("fleet-vocab.json", json!({ "replacements": [["\\bgpu (one|1)\\b", "gpu-\\1"]] })),
        ]
    }

    #[tokio::test]
    async fn transcribe_asks_the_primary_with_his_vocabulary_and_applies_his_fixes() {
        if skip() { return; }
        let h = harness(Opts { primary: "ok", vocab: owner_vocab(), ..Opts::default() }).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.json_text().await["text"], "Open Deskflow on gpu-one.");
        assert!(h.seen.lanes.lock().unwrap().is_empty(), "no fallback was needed");
        let primary = h.seen.primary.lock().unwrap();
        let (_, body) = &primary[0];
        assert_eq!(body["model"], "salm");
        let content = &body["messages"][0]["content"];
        assert_eq!(body["messages"][0]["role"], "user");
        let text = content[0]["text"].as_str().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert!(text.ends_with(" <|audio|>"), "{text}");
        assert!(text.contains("spell it exactly as written here: gpu-box, Deskflow, postgres."), "{text}");
        assert_eq!(content[1]["type"], "input_audio");
        assert_eq!(content[1]["input_audio"]["format"], "wav");
        let audio = Base64::decode_vec(content[1]["input_audio"]["data"].as_str().unwrap()).unwrap();
        assert_eq!(audio, wav());
    }

    #[tokio::test]
    async fn transcribe_falls_back_from_the_primary_in_order_with_the_fixes_applied() {
        if skip() { return; }
        for primary in ["bad", "empty", "dead"] {
            let h = harness(Opts { primary, asr: vec!["bad", "ok"], vocab: owner_vocab(), ..Opts::default() }).await;
            let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
            assert_eq!(res.status(), 200, "{primary}");
            assert_eq!(res.json_text().await["text"], "hello assistant", "{primary}");
            let tried = h.seen.primary.lock().unwrap().len();
            assert_eq!(tried, usize::from(primary != "dead"), "{primary}");
            let lanes = h.seen.lanes.lock().unwrap().clone();
            assert_eq!(lanes.iter().map(|l| l.0.as_str()).collect::<Vec<_>>(), ["bad", "ok"], "{primary}");
        }
        // The fallback's words get the owner's fixes too.
        let fixes = vec![("vocab.json", json!({ "fixes": [["hello assistant", "Hello, Assistant"]] }))];
        let h = harness(Opts { primary: "bad", vocab: fixes, ..Opts::default() }).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
        assert_eq!(res.json_text().await["text"], "Hello, Assistant");
        // Everything down: still voice_offline.
        let h = harness(Opts { primary: "bad", asr: vec!["dead"], ..Opts::default() }).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(wav()).send().await.unwrap();
        assert_eq!(res.status(), 503);
    }

    #[test]
    fn the_primary_request_carries_the_instructions_then_the_audio() {
        let body = primary_request(b"RIFF....WAVE", &["gpu-box".into(), "postgres".into()]);
        let text = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            text,
            "Transcribe this dictation verbatim with normal punctuation and capitalization. The speaker often says these names and \
technical terms; when you hear one, spell it exactly as written here: gpu-box, postgres. Do not add, answer or summarize \
anything. Output only the transcript. <|audio|>"
        );
        assert_eq!(body["messages"][0]["content"][1]["input_audio"]["data"], "UklGRi4uLi5XQVZF");
        let bare = primary_request(b"x", &[]);
        let text = bare["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("spell it") && text.ends_with(" <|audio|>"), "{text}");
        assert_eq!(service("http://100.64.0.7:8806/v1/chat/completions"), "100.64.0.7:8806");
    }

    #[tokio::test]
    async fn transcribe_bounds_its_input() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(vec![0u8; 100]).send().await.unwrap();
        assert_eq!(res.status(), 415);
        let mut big = wav();
        big.resize(MAX_WAV_BYTES + 1, 0);
        let res = client(&h.url, reqwest::Method::POST, "/api/voice/transcribe").body(big).send().await.unwrap();
        assert_eq!(res.status(), 413);
        assert!(h.seen.lanes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn speak_uses_the_voice_index() {
        if skip() { return; }
        let h = harness(Opts::default()).await;
        let res = post_json(&h.url, "/api/voice/speak", json!({ "text": "Hello." })).send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "audio/wav");
        assert_eq!(res.headers()["cache-control"], "no-store");
        assert_eq!(&res.bytes().await.unwrap()[..4], b"RIFF");
        let tts = h.seen.tts.lock().unwrap();
        assert_eq!(tts[0]["voice"], "4");
        assert_eq!(tts[0]["input"], "Hello.");
    }

    #[tokio::test]
    async fn speak_reports_voice_offline_and_bounds_text() {
        if skip() { return; }
        let h = harness(Opts { tts_down: true, ..Opts::default() }).await;
        let res = post_json(&h.url, "/api/voice/speak", json!({ "text": "Hello." })).send().await.unwrap();
        assert_eq!(res.status(), 503);
        assert_eq!(res.json_text().await["error"], "voice_offline");
        let long = "x".repeat(MAX_SPEAK_CHARS + 1);
        let res = post_json(&h.url, "/api/voice/speak", json!({ "text": long })).send().await.unwrap();
        assert_eq!(res.status(), 413);
    }

    #[test]
    fn the_key_comes_from_an_env_file_or_a_bare_file() {
        assert_eq!(parse_key("A=1\nAPI_SERVER_KEY=abc123\nB=2\n").as_deref(), Some("abc123"));
        assert_eq!(parse_key("API_SERVER_KEY=\"abc123\"\n").as_deref(), Some("abc123"));
        assert_eq!(parse_key("abc123\n").as_deref(), Some("abc123"));
        assert_eq!(parse_key("API_SERVER_ENABLED=true\n"), None);
        assert_eq!(parse_key("API_SERVER_KEY=\n"), None);
        assert_eq!(parse_key(""), None);
    }

    #[test]
    fn voices_resolve_to_the_right_index() {
        assert_eq!(voice_index("Aria"), Some("0"));
        assert_eq!(voice_index("sofia"), Some("4"));
        assert_eq!(voice_index("2"), Some("2"));
        assert_eq!(voice_index("5"), None);
        assert_eq!(voice_index("alloy"), None);
    }

    #[test]
    fn session_ids_on_disk_are_checked() {
        assert!(valid_session_id("lumbridge_1793768544"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../../etc/passwd"));
        assert!(!valid_session_id("a/b"));
    }

    #[test]
    fn sse_parser_handles_splits_comments_and_crlf() {
        let mut p = SseParser::default();
        assert_eq!(p.push(b"event: x\r\nda").unwrap(), vec![]);
        assert_eq!(
            p.push(b"ta: 1\r\ndata: 2\r\n\r\n: ping\n\n").unwrap(),
            vec![SseItem::Event { event: "x".into(), data: "1\n2".into() }, SseItem::Comment]
        );
        let snowman = "data: \u{2603}\n\n".as_bytes();
        assert_eq!(p.push(&snowman[..7]).unwrap(), vec![]);
        assert_eq!(
            p.push(&snowman[7..]).unwrap(),
            vec![SseItem::Event { event: String::new(), data: "\u{2603}".into() }]
        );
    }

    #[test]
    fn sse_parser_refuses_an_endless_line() {
        let mut p = SseParser::default();
        assert!(p.push(&vec![b'x'; MAX_SSE_LINE + 1]).is_err());
    }

    #[test]
    fn a_failed_turn_is_an_error_not_a_quiet_end() {
        let item = SseItem::Event {
            event: String::new(),
            data: r#"{"choices":[{"delta":{},"finish_reason":"error"}]}"#.into(),
        };
        assert!(matches!(translate(item)[..], [Translated::Failed]));
        let item = SseItem::Event {
            event: String::new(),
            data: r#"{"choices":[{"delta":{},"finish_reason":"cancelled"}]}"#.into(),
        };
        assert!(matches!(translate(item)[..], [Translated::Failed]));
    }

    trait JsonText {
        async fn json_text(self) -> Value;
    }
    impl JsonText for reqwest::Response {
        async fn json_text(self) -> Value {
            serde_json::from_slice(&self.bytes().await.unwrap()).unwrap()
        }
    }
}
