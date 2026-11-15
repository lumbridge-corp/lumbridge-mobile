//! The listeners. `tailscale serve --tcp=443 --proxy-protocol=2` hands us raw TCP with a PROXY v2 header, which is the
//! only way to learn the tailnet source, then we terminate TLS. Plain HTTP stays for scripts/dev.sh.
//!
//! Anything on this machine can connect to the loopback port and forge a PROXY header, so a source IP is no credential
//! by itself: every API call and WebSocket still needs a device token (docs/ARCHITECTURE.md).

use crate::{config::TlsFiles, whois, AppState};
use axum::{extract::ConnectInfo, Router};
use hyper_util::{
    rt::{TokioExecutor, TokioIo, TokioTimer},
    server::conn::auto,
};
use std::{
    collections::HashMap,
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    os::unix::fs::MetadataExt,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    net::TcpListener,
};
use tokio_rustls::{rustls, TlsAcceptor};
use tower::ServiceExt;

const SIGNATURE: [u8; 12] = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];
const PROXY_FIXED: usize = 16;
const PROXY_MAX_EXTRA: usize = 512;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Open connections, whoever they're from, so nothing can run the process out of file descriptors.
const MAX_CONNECTIONS: usize = 1024;
/// From one admitted node. A phone needs a handful; this is so one broken client can't take them all.
const MAX_PER_SOURCE: usize = 64;
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

/// Refuses anything that isn't a literal loopback address.
pub fn require_loopback(bind: &str) -> Result<SocketAddr, String> {
    let addr: SocketAddr = bind.parse().map_err(|_| format!("{bind} isn't an ip:port"))?;
    if addr.ip().is_loopback() {
        Ok(addr)
    } else {
        Err(format!("{bind} isn't loopback"))
    }
}

/// The 16 fixed bytes: how many more to read.
fn proxy_extra(fixed: &[u8; PROXY_FIXED]) -> Result<usize, &'static str> {
    if fixed[..12] != SIGNATURE {
        return Err("no PROXY v2 signature");
    }
    if fixed[12] >> 4 != 2 {
        return Err("not PROXY version 2");
    }
    let extra = u16::from_be_bytes([fixed[14], fixed[15]]) as usize;
    if extra > PROXY_MAX_EXTRA {
        return Err("oversized PROXY header");
    }
    Ok(extra)
}

/// The source address. Only PROXY-command TCP counts: LOCAL and UNSPEC say nothing about who connected.
fn proxy_source(fixed: &[u8; PROXY_FIXED], rest: &[u8]) -> Result<SocketAddr, &'static str> {
    if fixed[12] & 0x0f != 1 {
        return Err("not a PROXY command");
    }
    let (ip, port) = match fixed[13] {
        0x11 if rest.len() >= 12 => {
            let a: [u8; 4] = rest[0..4].try_into().unwrap();
            (IpAddr::V4(Ipv4Addr::from(a)), u16::from_be_bytes([rest[8], rest[9]]))
        }
        0x21 if rest.len() >= 36 => {
            let a: [u8; 16] = rest[0..16].try_into().unwrap();
            (IpAddr::V6(Ipv6Addr::from(a)), u16::from_be_bytes([rest[32], rest[33]]))
        }
        _ => return Err("unsupported PROXY address family"),
    };
    Ok(SocketAddr::new(ip.to_canonical(), port))
}

/// Reads exactly the header, leaving the TLS bytes behind it on the socket.
async fn read_proxy<R: AsyncReadExt + Unpin>(stream: &mut R) -> Result<SocketAddr, String> {
    let mut fixed = [0u8; PROXY_FIXED];
    stream.read_exact(&mut fixed).await.map_err(|e| format!("PROXY header: {e}"))?;
    let extra = proxy_extra(&fixed)?;
    let mut rest = vec![0u8; extra];
    stream.read_exact(&mut rest).await.map_err(|e| format!("PROXY header: {e}"))?;
    Ok(proxy_source(&fixed, &rest)?)
}

type Stamp = (u64, i64, i64, u64);

fn stamp(path: &str) -> Option<Stamp> {
    fs::metadata(path).ok().map(|m| (m.ino(), m.mtime(), m.mtime_nsec(), m.size()))
}

fn load_acceptor(files: &TlsFiles) -> Result<TlsAcceptor, String> {
    let chain = rustls_pemfile::certs(&mut fs::read(&files.cert).map_err(|e| format!("cert: {e}"))?.as_slice())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("cert: {e}"))?;
    if chain.is_empty() {
        return Err("cert: no certificates".into());
    }
    let key = rustls_pemfile::private_key(&mut fs::read(&files.key).map_err(|e| format!("key: {e}"))?.as_slice())
        .map_err(|e| format!("key: {e}"))?
        .ok_or("key: none found")?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    // with_single_cert also checks that the key belongs to the cert, which catches a half-finished renewal.
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|e| format!("cert/key: {e}"))?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// The certificate in use. Each new connection checks the files, so a renewal needs no restart; a bad renewal keeps
/// the old certificate and is retried on the next connection.
pub struct Certs {
    files: TlsFiles,
    seen: Mutex<(Option<Stamp>, Option<Stamp>)>,
    current: RwLock<TlsAcceptor>,
}

impl Certs {
    pub fn load(files: TlsFiles) -> Result<Self, String> {
        let seen = (stamp(&files.cert), stamp(&files.key));
        let current = load_acceptor(&files)?;
        Ok(Self { files, seen: Mutex::new(seen), current: RwLock::new(current) })
    }

    fn acceptor(&self) -> TlsAcceptor {
        let now = (stamp(&self.files.cert), stamp(&self.files.key));
        let mut seen = self.seen.lock().unwrap();
        if *seen != now {
            match load_acceptor(&self.files) {
                Ok(fresh) => {
                    *self.current.write().unwrap() = fresh;
                    *seen = now;
                    eprintln!("reloaded the TLS certificate");
                }
                Err(e) => eprintln!("keeping the old TLS certificate: {e}"),
            }
        }
        self.current.read().unwrap().clone()
    }
}

#[derive(Default)]
struct Counts {
    total: usize,
    per_source: HashMap<IpAddr, usize>,
}

/// How many connections are open, and from whom.
#[derive(Default)]
struct Slots(Mutex<Counts>);

/// One open connection's place. It lives inside the stream, so an upgraded WebSocket keeps it until the socket closes.
struct Slot {
    slots: Arc<Slots>,
    source: Option<IpAddr>,
}

impl Slots {
    fn open(self: &Arc<Self>) -> Option<Slot> {
        let mut c = self.0.lock().unwrap();
        if c.total >= MAX_CONNECTIONS {
            return None;
        }
        c.total += 1;
        Some(Slot { slots: self.clone(), source: None })
    }
}

impl Slot {
    /// Now we know who it is: count it against them, or refuse if they already have too many.
    fn claim(&mut self, ip: IpAddr) -> bool {
        let mut c = self.slots.0.lock().unwrap();
        let n = c.per_source.entry(ip).or_default();
        if *n >= MAX_PER_SOURCE {
            return false;
        }
        *n += 1;
        self.source = Some(ip);
        true
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut c = self.slots.0.lock().unwrap();
        c.total -= 1;
        if let Some(ip) = self.source {
            if let Some(n) = c.per_source.get_mut(&ip) {
                *n -= 1;
                if *n == 0 {
                    c.per_source.remove(&ip);
                }
            }
        }
    }
}

/// When a connection last moved a byte.
struct Activity {
    base: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Arc<Self> {
        Arc::new(Self { base: Instant::now(), last_ms: AtomicU64::new(0) })
    }
    fn touch(&self) {
        self.last_ms.store(self.base.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    /// Returns once nothing has moved for `limit`.
    async fn idle_for(&self, limit: Duration) {
        loop {
            let quiet = self.base.elapsed().saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)));
            if quiet >= limit {
                return;
            }
            tokio::time::sleep(limit - quiet).await;
        }
    }
}

/// A stream that notes when bytes move and keeps its connection's slot.
struct Tracked<S> {
    inner: S,
    activity: Arc<Activity>,
    _slot: Slot,
}

impl<S: AsyncRead + Unpin> AsyncRead for Tracked<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.activity.touch();
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Tracked<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.activity.touch();
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// One accepted stream. `peer` becomes `ConnectInfo<SocketAddr>`. A connection that moves nothing for `idle` is closed;
/// a WebSocket has left this function by then and keeps itself alive (`ws`).
async fn serve_connection<S>(stream: S, slot: Slot, peer: SocketAddr, app: Router, idle: Duration)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let activity = Activity::new();
    let stream = Tracked { inner: stream, activity: activity.clone(), _slot: slot };
    let service = hyper::service::service_fn(move |mut req: hyper::Request<hyper::body::Incoming>| {
        req.extensions_mut().insert(ConnectInfo(peer));
        app.clone().oneshot(req.map(axum::body::Body::new))
    });
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder.http1().timer(TokioTimer::new());
    builder.http2().timer(TokioTimer::new());
    tokio::select! {
        served = builder.serve_connection_with_upgrades(TokioIo::new(stream), service) => {
            if let Err(e) = served {
                // A client going away isn't news; anything else is worth a line. Never the request itself.
                let text = e.to_string();
                if !text.contains("connection closed") && !text.contains("reset") {
                    eprintln!("connection from {peer}: {text}");
                }
            }
        }
        () = activity.idle_for(idle) => {}
    }
}

/// Admission comes first: the PROXY header says who it is and whois says yes or no, all before any TLS. A node we'd refuse
/// costs one closed socket, so it can't hold connections open. Loopback goes on to `gate`, for the local /healthz probe.
async fn admit_connection(state: &AppState, peer: SocketAddr, slot: &mut Slot) -> Result<(), String> {
    if !peer.ip().is_loopback() {
        whois::check(&state.cfg, &state.auth.whois, peer.ip()).await.map_err(|why| format!("{}: {why}", peer.ip()))?;
    }
    if !slot.claim(peer.ip()) {
        return Err(format!("{}: too many connections", peer.ip()));
    }
    Ok(())
}

pub async fn serve_tls(bind: SocketAddr, certs: Certs, app: Router, state: Arc<AppState>) -> std::io::Result<()> {
    let listener = TcpListener::bind(bind).await?;
    eprintln!("lumbridge-mobile-server TLS + PROXY on {bind}");
    let certs = Arc::new(certs);
    let slots = Arc::new(Slots::default());
    let idle = state.cfg.conn_idle;
    loop {
        // An error here is about one connection or a passing shortage (out of file descriptors), never the listener:
        // it must not take the gateway down with it.
        let (mut stream, from) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                eprintln!("accept: {e}");
                tokio::time::sleep(ACCEPT_RETRY).await;
                continue;
            }
        };
        // The bind is loopback, so this is belt and braces: PROXY headers are only believed from this machine.
        if !from.ip().is_loopback() {
            continue;
        }
        let Some(mut slot) = slots.open() else { continue };
        let app = app.clone();
        let certs = certs.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let _ = stream.set_nodelay(true);
            let accepted = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
                let peer = read_proxy(&mut stream).await?;
                admit_connection(&state, peer, &mut slot).await?;
                let tls = certs.acceptor().accept(stream).await.map_err(|e| format!("TLS: {e}"))?;
                Ok::<_, String>((peer, tls))
            })
            .await;
            match accepted {
                Ok(Ok((peer, tls))) => serve_connection(tls, slot, peer, app, idle).await,
                Ok(Err(e)) => eprintln!("refused a connection: {e}"),
                Err(_) => eprintln!("refused a connection: too slow to start"),
            }
        });
    }
}

pub async fn serve_plain(bind: SocketAddr, app: Router) -> std::io::Result<()> {
    let listener = TcpListener::bind(bind).await?;
    eprintln!("lumbridge-mobile-server on {bind}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4_header(cmd: u8, fam: u8, src: [u8; 4], port: u16) -> Vec<u8> {
        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x20 | cmd, fam, 0, 12]);
        h.extend_from_slice(&src);
        h.extend_from_slice(&[127, 0, 0, 1]);
        h.extend_from_slice(&port.to_be_bytes());
        h.extend_from_slice(&443u16.to_be_bytes());
        h
    }

    async fn parse(bytes: &[u8]) -> Result<SocketAddr, String> {
        let mut reader = bytes;
        read_proxy(&mut reader).await
    }

    #[tokio::test]
    async fn reads_a_v4_source() {
        let h = v4_header(1, 0x11, [100, 64, 0, 21], 51000);
        assert_eq!(parse(&h).await.unwrap(), "100.64.0.21:51000".parse().unwrap());
    }

    #[tokio::test]
    async fn reads_a_v6_source_and_unmaps_v4() {
        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x21, 0x21, 0, 36]);
        let src: Ipv6Addr = "fd7a:115c:a1e0::1".parse().unwrap();
        h.extend_from_slice(&src.octets());
        h.extend_from_slice(&[0; 16]);
        h.extend_from_slice(&[0x12, 0x34, 0x01, 0xbb]);
        assert_eq!(parse(&h).await.unwrap(), "[fd7a:115c:a1e0::1]:4660".parse().unwrap());

        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x21, 0x21, 0, 36]);
        let mapped: Ipv6Addr = "::ffff:100.64.0.25".parse().unwrap();
        h.extend_from_slice(&mapped.octets());
        h.extend_from_slice(&[0; 20]);
        assert_eq!(parse(&h).await.unwrap().ip(), "100.64.0.25".parse::<IpAddr>().unwrap());
    }

    #[tokio::test]
    async fn stops_at_the_end_of_the_header_with_tlvs() {
        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x21, 0x11, 0, 15]);
        h.extend_from_slice(&[100, 64, 0, 1, 127, 0, 0, 1, 1, 0, 1, 0xbb]);
        h.extend_from_slice(&[0x04, 0, 0]); // a TLV serve might add
        h.extend_from_slice(b"\x16\x03\x01rest-is-tls");
        let mut reader = h.as_slice();
        assert_eq!(read_proxy(&mut reader).await.unwrap().ip(), "100.64.0.1".parse::<IpAddr>().unwrap());
        assert_eq!(&reader[..3], b"\x16\x03\x01");
    }

    #[tokio::test]
    async fn refuses_everything_malformed() {
        let good = v4_header(1, 0x11, [100, 64, 0, 1], 1);
        assert!(parse(&[]).await.is_err(), "nothing");
        assert!(parse(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.is_err(), "no header");
        assert!(parse(b"PROXY TCP4 100.64.0.1 127.0.0.1 1 443\r\n").await.is_err(), "v1 text");
        assert!(parse(b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03aaaaaaaa").await.is_err(), "bare TLS");
        assert!(parse(&good[..10]).await.is_err(), "cut in the signature");
        assert!(parse(&good[..20]).await.is_err(), "cut in the addresses");
        let mut h = good.clone();
        h[0] ^= 1;
        assert!(parse(&h).await.is_err(), "bad signature");
        let mut h = good.clone();
        h[12] = 0x11;
        assert!(parse(&h).await.is_err(), "wrong version");
        assert!(parse(&v4_header(0, 0x11, [100, 64, 0, 1], 1)).await.is_err(), "LOCAL");
        assert!(parse(&v4_header(2, 0x11, [100, 64, 0, 1], 1)).await.is_err(), "unknown command");
        assert!(parse(&v4_header(1, 0x12, [100, 64, 0, 1], 1)).await.is_err(), "UDP");
        assert!(parse(&v4_header(1, 0x00, [100, 64, 0, 1], 1)).await.is_err(), "UNSPEC");
        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x21, 0x11, 0, 4, 100, 64, 0, 1]);
        assert!(parse(&h).await.is_err(), "too short for v4");
        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x21, 0x21, 0, 12]);
        h.extend_from_slice(&[0; 12]);
        assert!(parse(&h).await.is_err(), "too short for v6");
        let mut h = SIGNATURE.to_vec();
        h.extend_from_slice(&[0x21, 0x11, 0xff, 0xff]);
        assert!(parse(&h).await.is_err(), "oversized");
    }

    #[test]
    fn connections_are_bounded_and_given_back() {
        let slots = Arc::new(Slots::default());
        let ip: IpAddr = "100.64.0.1".parse().unwrap();
        let mine: Vec<Slot> = (0..MAX_PER_SOURCE)
            .map(|_| {
                let mut s = slots.open().unwrap();
                assert!(s.claim(ip));
                s
            })
            .collect();
        let mut one_more = slots.open().unwrap();
        assert!(!one_more.claim(ip), "over the per-source limit");
        assert!(one_more.claim("100.64.0.2".parse().unwrap()), "someone else isn't affected");
        drop(mine);
        drop(one_more);
        let c = slots.0.lock().unwrap();
        assert_eq!(c.total, 0);
        assert!(c.per_source.is_empty());
        drop(c);
        let all: Vec<Slot> = (0..MAX_CONNECTIONS).map(|_| slots.open().unwrap()).collect();
        assert!(slots.open().is_none(), "over the total");
        drop(all);
        assert!(slots.open().is_some());
    }

    #[tokio::test]
    async fn a_quiet_connection_is_seen_as_idle_and_a_busy_one_isnt() {
        let a = Activity::new();
        let limit = Duration::from_millis(120);
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            a.touch();
        }
        let quick = tokio::time::timeout(Duration::from_millis(60), a.idle_for(limit)).await;
        assert!(quick.is_err(), "it moved a moment ago");
        assert!(tokio::time::timeout(Duration::from_millis(400), a.idle_for(limit)).await.is_ok());
    }

    #[test]
    fn only_loopback_binds() {
        assert!(require_loopback("127.0.0.1:8451").is_ok());
        assert!(require_loopback("[::1]:8451").is_ok());
        for bad in ["0.0.0.0:8451", "100.64.0.25:443", "198.51.100.12:8451", "[::]:8451", "localhost:8451", "nonsense"] {
            assert!(require_loopback(bad).is_err(), "{bad}");
        }
    }
}
