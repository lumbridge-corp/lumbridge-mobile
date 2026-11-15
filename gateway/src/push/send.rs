//! One encrypted Web Push request (RFC 8030, 8291 aes128gcm, 8292 VAPID) with bounded retries.
//!
//! What works with iPhones:
//! - TTL and the VAPID token both 12 hours.
//! - The subject is a real address (`subject()`). Apple answers 403 BadJwtToken to a subject that isn't a URL or mailto,
//!   and to a localhost one.
//! - No `Topic` header: Apple rejects it with 400 BadWebPushTopic. The notification's
//!   `tag` collapses on the device instead.

use super::store::Sub;
use base64ct::{Base64UrlUnpadded, Encoding};
use reqwest::{header::HeaderValue, redirect, StatusCode};
use std::time::Duration;
use web_push_native::{jwt_simple::algorithms::ES256KeyPair, p256::PublicKey, Auth, WebPushBuilder};

/// The VAPID subject: LUMBRIDGE_PUSH_SUBJECT (`mailto:` or `https:`), else `mailto:` and LUMBRIDGE_LOGIN, the owner's address.
pub fn subject() -> &'static str {
    static SUBJECT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SUBJECT.get_or_init(|| {
        let set = std::env::var("LUMBRIDGE_PUSH_SUBJECT").unwrap_or_default();
        if set.starts_with("mailto:") || set.starts_with("https://") {
            return set;
        }
        format!("mailto:{}", std::env::var("LUMBRIDGE_LOGIN").ok().filter(|l| l.contains('@')).unwrap_or_else(|| "owner@example.com".into()))
    })
}
const VALID_FOR: Duration = Duration::from_secs(12 * 60 * 60);
const RETRY_AFTER: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(4)];
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Sent,
    /// 404 or 410: the subscription is dead.
    Gone,
    Failed(String),
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(redirect::Policy::none())
        .user_agent("lumbridge-mobile-server")
        .build()
        .expect("http client")
}

/// Push services only, so a subscription can't aim the gateway at anything else.
pub fn valid_endpoint(endpoint: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(endpoint) else { return false };
    if endpoint.len() > 1024 {
        return false;
    }
    // Dev builds only: the end-to-end test's fake push service on loopback.
    #[cfg(feature = "dev-identity")]
    if u.scheme() == "http" && u.host_str() == Some("127.0.0.1") {
        return true;
    }
    let host = u.host_str().unwrap_or("");
    let is = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    u.scheme() == "https"
        && u.port().is_none()
        && (is("push.apple.com") || is("fcm.googleapis.com") || is("push.services.mozilla.com") || is("notify.windows.com"))
}

fn parse_keys(p256dh: &str, auth: &str) -> Option<(PublicKey, Auth)> {
    let key = PublicKey::from_sec1_bytes(&Base64UrlUnpadded::decode_vec(p256dh.trim_end_matches('=')).ok()?).ok()?;
    let auth = Base64UrlUnpadded::decode_vec(auth.trim_end_matches('=')).ok()?;
    (auth.len() == 16).then(|| (key, Auth::clone_from_slice(&auth)))
}

pub fn valid_keys(p256dh: &str, auth: &str) -> bool {
    parse_keys(p256dh, auth).is_some()
}

pub fn build(sub: &Sub, vapid: &ES256KeyPair, body: &str) -> Result<http::Request<Vec<u8>>, String> {
    let (key, auth) = parse_keys(&sub.p256dh, &sub.auth).ok_or("bad subscription keys")?;
    let uri: http::Uri = sub.endpoint.parse().map_err(|_| "bad endpoint")?;
    WebPushBuilder::new(uri, key, auth)
        .with_valid_duration(VALID_FOR)
        .with_vapid(vapid, subject())
        .build(body)
        .map_err(|e| format!("encrypt: {e}"))
}

/// Which push service, for logs. The endpoint's path is a credential and is never logged.
pub fn service(endpoint: &str) -> String {
    reqwest::Url::parse(endpoint).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default()
}

pub async fn send(http: &reqwest::Client, sub: &Sub, vapid: &ES256KeyPair, body: &str, high: bool) -> Outcome {
    let mut last = String::new();
    for attempt in 0..=RETRY_AFTER.len() {
        // Rebuilt each try: fresh salt and key, and a fresh token.
        let req = match build(sub, vapid, body) {
            Ok(r) => r,
            Err(e) => return Outcome::Failed(e),
        };
        let (parts, payload) = req.into_parts();
        let result = http
            .post(&sub.endpoint)
            .headers(parts.headers)
            .header("Urgency", HeaderValue::from_static(if high { "high" } else { "normal" }))
            .body(payload)
            .send()
            .await;
        let mut wait = RETRY_AFTER.get(attempt).copied();
        match result {
            Ok(res) => {
                let status = res.status();
                if status.is_success() {
                    return Outcome::Sent;
                }
                if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
                    return Outcome::Gone;
                }
                let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()?.parse().ok());
                // Apple and Google say why in a short JSON body; it holds no subscription data.
                let reason: String = res.text().await.unwrap_or_default().chars().take(200).collect();
                last = format!("{} {}", status.as_u16(), reason.trim());
                if status != StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() {
                    return Outcome::Failed(last);
                }
                if let (Some(_), Some(secs)) = (wait, retry_after) {
                    wait = Some(Duration::from_secs(secs).min(MAX_RETRY_AFTER));
                }
            }
            // A transport error's text can quote the URL, and the URL is a credential.
            Err(e) => last = if e.is_timeout() { "timed out".into() } else { "couldn't connect".into() },
        }
        match wait {
            Some(d) => tokio::time::sleep(d).await,
            None => break,
        }
    }
    Outcome::Failed(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_push_native::{jwt_simple::prelude::*, p256::SecretKey};

    /// A browser's side of a subscription.
    fn browser() -> (SecretKey, Auth, Sub) {
        let secret = SecretKey::random(&mut web_push_native::p256::elliptic_curve::rand_core::OsRng);
        let auth = Auth::clone_from_slice(b"0123456789abcdef");
        let point = web_push_native::p256::EncodedPoint::from(secret.public_key());
        let sub = Sub {
            endpoint: "https://web.push.apple.com/QabcDEF".into(),
            p256dh: Base64UrlUnpadded::encode_string(point.as_bytes()),
            auth: Base64UrlUnpadded::encode_string(&auth),
            label: String::new(),
            device: None,
            created_ms: 0,
            failures: 0,
        };
        (secret, auth, sub)
    }

    #[test]
    fn only_push_services_are_accepted() {
        for good in [
            "https://web.push.apple.com/abc",
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://wns2-par02p.notify.windows.com/w/?token=abc",
        ] {
            assert!(valid_endpoint(good), "{good}");
        }
        for bad in [
            "http://web.push.apple.com/abc",
            "https://web.push.apple.com:8443/abc",
            "https://push.apple.com.evil.example/abc",
            "https://evilpush.apple.com.example/abc",
            "https://100.64.0.1/abc",
            "https://notpush.apple.com@evil.example/abc",
            "not a url",
        ] {
            assert!(!valid_endpoint(bad), "{bad}");
        }
        assert!(!valid_endpoint(&format!("https://web.push.apple.com/{}", "a".repeat(1100))));
    }

    #[test]
    fn bad_keys_are_refused() {
        let (_, _, sub) = browser();
        assert!(valid_keys(&sub.p256dh, &sub.auth));
        assert!(!valid_keys("AAAA", &sub.auth));
        assert!(!valid_keys(&sub.p256dh, "AAAA"));
        assert!(!valid_keys("!!!", "!!!"));
    }

    #[test]
    fn a_request_decrypts_on_the_browser_side_and_has_the_right_headers() {
        let (secret, auth, sub) = browser();
        let vapid = ES256KeyPair::generate();
        let req = build(&sub, &vapid, r#"{"title":"x"}"#).unwrap();
        let h = req.headers();
        assert_eq!(h["content-encoding"], "aes128gcm");
        assert_eq!(h["ttl"], "43200");
        assert!(h.get("topic").is_none(), "Apple rejects Topic with 400 BadWebPushTopic");
        // The body starts with the aes128gcm header: salt(16) rs(4) idlen(1) keyid(65).
        assert_eq!(req.body()[20], 65);
        let plain = web_push_native::decrypt(req.body().clone(), &secret, &auth).unwrap();
        assert_eq!(plain, br#"{"title":"x"}"#);
    }

    #[test]
    fn the_vapid_token_is_what_apple_asks_for() {
        let (_, _, sub) = browser();
        let vapid = ES256KeyPair::generate();
        let req = build(&sub, &vapid, "x").unwrap();
        let header = req.headers()["authorization"].to_str().unwrap().to_string();
        let rest = header.strip_prefix("vapid t=").expect("vapid scheme");
        let (token, key) = rest.split_once(", k=").or_else(|| rest.split_once(",k=")).expect("k");
        assert_eq!(key, super::super::store::public_key(&vapid));
        let claims = vapid.public_key().verify_token::<NoCustomClaims>(token, None).expect("signature");
        assert_eq!(claims.subject.as_deref(), Some(subject()));
        assert!(subject().starts_with("mailto:") && !subject().contains("localhost"));
        let aud = claims.audiences.unwrap().into_string().unwrap();
        assert_eq!(aud, "https://web.push.apple.com");
        let left = claims.expires_at.unwrap().as_secs() as i64 - Clock::now_since_epoch().as_secs() as i64;
        assert!(left > 11 * 3600 && left <= 12 * 3600 + 60, "{left}");
    }

    #[test]
    fn logs_name_the_service_not_the_endpoint() {
        assert_eq!(service("https://web.push.apple.com/SECRET"), "web.push.apple.com");
    }
}
