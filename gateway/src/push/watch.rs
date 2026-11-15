//! The watcher's own connection to core. Read-only by construction: `Events` keeps the pipe to core
//! private, and the only things ever written are the two constants below and CREDIT frames. No method
//! takes a method name or bytes, so nothing in here can call anything else on the core.

use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::mpsc,
    task::JoinHandle,
};

const HELLO: &str = r#"{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}"#;
const SUBSCRIBE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"events.subscribe","params":{}}"#;
const HEADER: usize = 9;
const DATA: u8 = 0;
const CREDIT: u8 = 1;
const CLOSE: u8 = 2;
const MAX_FRAME: usize = 16 * 1024 * 1024;
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// Not a fault: core is the desktop session's to start, and this keeps looking for it.
pub const CORE_DOWN: &str = "core isn't running";

fn frame(channel: u32, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(&channel.to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

async fn read_frame(from: &mut BufReader<ChildStdout>) -> Result<(u32, u8, Vec<u8>), String> {
    let mut head = [0u8; HEADER];
    from.read_exact(&mut head).await.map_err(|e| format!("core: {e}"))?;
    let len = u32::from_le_bytes(head[5..9].try_into().unwrap()) as usize;
    if len > MAX_FRAME {
        return Err("oversized frame from core".into());
    }
    let mut payload = vec![0u8; len];
    from.read_exact(&mut payload).await.map_err(|e| format!("core: {e}"))?;
    Ok((u32::from_le_bytes(head[0..4].try_into().unwrap()), head[4], payload))
}

/// Whole JSON lines out of a byte stream that may split them anywhere.
#[derive(Default)]
struct Lines(Vec<u8>);

impl Lines {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.0.extend_from_slice(bytes);
        let whole = self.0.iter().rposition(|b| *b == b'\n').map_or(0, |at| at + 1);
        let done: Vec<u8> = self.0.drain(..whole).collect();
        if self.0.len() > MAX_FRAME {
            return Err("oversized event line".into());
        }
        Ok(done.split(|b| *b == b'\n').filter(|l| !l.is_empty()).filter_map(|l| serde_json::from_slice(l).ok()).collect())
    }
}

/// A live subscription: a snapshot, then lines on `next`. Dropping it ends the `hc connect` child.
pub struct Events {
    pub seq: u64,
    pub terminals: Vec<Value>,
    /// What this core calls itself.
    pub core_name: String,
    lines: mpsc::Receiver<Result<Value, String>>,
    reader: JoinHandle<()>,
}

impl Drop for Events {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Events {
    pub async fn open(hc: &str) -> Result<Self, String> {
        tokio::time::timeout(OPEN_TIMEOUT, Self::handshake(hc)).await.map_err(|_| "core didn't answer".to_string())?
    }

    async fn handshake(hc: &str) -> Result<Self, String> {
        if !crate::hc::running().await {
            return Err(CORE_DOWN.into());
        }
        let mut child = crate::hc::connect(hc)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("hc connect: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

        stdin.write_all(format!("{HELLO}\n").as_bytes()).await.map_err(|e| e.to_string())?;
        let mut line = String::new();
        stdout.read_line(&mut line).await.map_err(|e| e.to_string())?;
        let hello: Value = serde_json::from_str(&line).map_err(|e| format!("hello: {e}"))?;
        if hello["result"]["framed"] != true {
            return Err("core refused framed mode".into());
        }
        let core_name = hello["result"]["core"]["name"].as_str().unwrap_or("").to_string();

        stdin.write_all(&frame(0, DATA, SUBSCRIBE.as_bytes())).await.map_err(|e| e.to_string())?;
        let reply = loop {
            let (channel, kind, payload) = read_frame(&mut stdout).await?;
            if channel == 0 && kind == DATA {
                let m: Value = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
                if m["id"] == 1 {
                    break m;
                }
            }
        };
        let result = &reply["result"];
        let channel = result["channel"].as_u64().ok_or("no event channel")? as u32;
        let (tx, lines) = mpsc::channel(256);
        let reader = tokio::spawn(pump(child, stdin, stdout, channel, tx));
        Ok(Self {
            seq: result["seq"].as_u64().unwrap_or(0),
            terminals: result["terminals"].as_array().cloned().unwrap_or_default(),
            core_name,
            lines,
            reader,
        })
    }

    /// The next line, or why the connection is over. Safe to cancel.
    pub async fn next(&mut self) -> Result<Value, String> {
        self.lines.recv().await.unwrap_or_else(|| Err("core closed".into()))
    }
}

/// Reads frames and returns credit. `_child` lives here so it dies with this task (kill_on_drop).
async fn pump(
    _child: Child,
    mut stdin: ChildStdin,
    mut stdout: BufReader<ChildStdout>,
    channel: u32,
    tx: mpsc::Sender<Result<Value, String>>,
) {
    let mut lines = Lines::default();
    let why = loop {
        let (ch, kind, payload) = match read_frame(&mut stdout).await {
            Ok(f) => f,
            Err(e) => break e,
        };
        if ch != channel {
            continue;
        }
        if kind == CLOSE {
            break "core closed the event channel".to_string();
        }
        if kind != DATA {
            continue;
        }
        let parsed = match lines.push(&payload) {
            Ok(p) => p,
            Err(e) => break e,
        };
        for line in parsed {
            if tx.send(Ok(line)).await.is_err() {
                return;
            }
        }
        let credit = frame(channel, CREDIT, &(payload.len() as u32).to_le_bytes());
        if let Err(e) = stdin.write_all(&credit).await {
            break format!("core: {e}");
        }
    };
    let _ = tx.send(Err(why)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_only_calls_this_module_can_make() {
        let method = |s: &str| serde_json::from_str::<Value>(s).unwrap()["method"].as_str().unwrap().to_string();
        assert_eq!(method(HELLO), "hello");
        assert_eq!(method(SUBSCRIBE), "events.subscribe");
        // Anything else would have to appear in this file's non-test source.
        let source = include_str!("watch.rs");
        let source = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["terminal.", "machine.", "file.", "server.", "doc."] {
            assert!(!source.contains(forbidden), "{forbidden}");
        }
        assert_eq!(source.matches("\"method\"").count(), 2);
    }

    #[test]
    fn frames_match_the_protocol() {
        assert_eq!(frame(7, CREDIT, &[1, 0, 0, 0]), vec![7, 0, 0, 0, 1, 4, 0, 0, 0, 1, 0, 0, 0]);
    }

    #[test]
    fn lines_split_anywhere() {
        let mut l = Lines::default();
        assert!(l.push(b"{\"a\":").unwrap().is_empty());
        assert_eq!(l.push(b"1}\n{\"b\":2}\n{\"c\"").unwrap(), vec![json!({"a":1}), json!({"b":2})]);
        assert_eq!(l.push(b":3}\n").unwrap(), vec![json!({"c":3})]);
        assert_eq!(l.push(b"not json\n{\"d\":4}\n").unwrap(), vec![json!({"d":4})]);
    }
}
