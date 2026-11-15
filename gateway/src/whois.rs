//! Who a tailnet source IP is, from tailscaled. `tailscale serve --tcp` carries raw TCP, so it adds no identity
//! headers: the source IP from the PROXY header is looked up here instead. Any doubt means no.

use crate::config::Config;
use serde::Deserialize;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::process::Command;

const ADMITTED_FOR: Duration = Duration::from_secs(60);
const REFUSED_FOR: Duration = Duration::from_secs(5);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
const CACHE_MAX: usize = 256;

#[derive(Deserialize)]
struct Raw {
    #[serde(rename = "Node")]
    node: RawNode,
    #[serde(rename = "UserProfile")]
    user: RawUser,
}

#[derive(Deserialize)]
struct RawNode {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Tags", default)]
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawUser {
    #[serde(rename = "LoginName")]
    login: String,
}

pub struct Identity {
    /// The MagicDNS name, like `phone.example-tailnet.ts.net.`; not the hostname, which the device picks.
    pub name: String,
    pub tags: Vec<String>,
    pub login: String,
}

pub fn parse(json: &str) -> Option<Identity> {
    let raw: Raw = serde_json::from_str(json).ok()?;
    if raw.node.name.is_empty() {
        return None;
    }
    Some(Identity { name: raw.node.name, tags: raw.node.tags.unwrap_or_default(), login: raw.user.login })
}

/// The admission rule, in one place. Default deny: only a node named exactly in the list, in our tailnet. A tagged node has
/// no owner, so the name decides; an untagged one must also be its owner's. A new device, or an old one renamed, is out
/// until someone adds it here.
pub fn decide(cfg: &Config, who: &Identity) -> Verdict {
    let fqdn = who.name.trim_end_matches('.');
    let short = fqdn.split('.').next().unwrap_or("");
    let ours = !cfg.tailnet.is_empty() && fqdn.strip_prefix(short).and_then(|r| r.strip_prefix('.')) == Some(cfg.tailnet.as_str());
    if !ours {
        return Err("not our tailnet");
    }
    if !cfg.allowed_nodes.iter().any(|n| n == short) {
        return Err("node not allowed");
    }
    if who.tags.is_empty() && who.login != cfg.login {
        return Err("another user's node");
    }
    Ok(())
}

/// 100.64.0.0/10 and fd7a:115c:a1e0::/48: the only addresses tailscaled hands out.
pub fn is_tailnet(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

type Verdict = Result<(), &'static str>;

#[derive(Default)]
pub struct Cache(Mutex<HashMap<IpAddr, (Instant, Verdict)>>);

impl Cache {
    fn get(&self, ip: IpAddr) -> Option<Verdict> {
        let map = self.0.lock().unwrap();
        map.get(&ip).filter(|(until, _)| Instant::now() < *until).map(|(_, verdict)| *verdict)
    }

    pub(crate) fn put(&self, ip: IpAddr, verdict: Verdict) {
        let ttl = if verdict.is_ok() { ADMITTED_FOR } else { REFUSED_FOR };
        let mut map = self.0.lock().unwrap();
        let now = Instant::now();
        if map.len() >= CACHE_MAX {
            map.retain(|_, (until, _)| now < *until);
        }
        if map.len() < CACHE_MAX {
            map.insert(ip, (now + ttl, verdict));
        }
    }
}

/// Is this source admitted? A failed lookup refuses and isn't cached, so the next request asks again.
pub async fn check(cfg: &Config, cache: &Cache, ip: IpAddr) -> Verdict {
    let ip = ip.to_canonical();
    if !is_tailnet(ip) {
        return Err("not a tailnet source");
    }
    if let Some(verdict) = cache.get(ip) {
        return verdict;
    }
    let who = lookup(cfg, ip).await.ok_or("whois failed")?;
    let verdict = decide(cfg, &who);
    cache.put(ip, verdict);
    verdict
}

/// The short tailnet name of a source, asked fresh: for a decision too important for the admission cache.
#[cfg_attr(feature = "dev-identity", allow(dead_code))]
pub async fn node_name(cfg: &Config, ip: IpAddr) -> Option<String> {
    let ip = ip.to_canonical();
    if !is_tailnet(ip) {
        return None;
    }
    let who = lookup(cfg, ip).await?;
    who.name.trim_end_matches('.').split('.').next().map(str::to_string)
}

async fn lookup(cfg: &Config, ip: IpAddr) -> Option<Identity> {
    let run = Command::new(&cfg.tailscale).args(["whois", "--json", &ip.to_string()]).kill_on_drop(true).output();
    let out = tokio::time::timeout(LOOKUP_TIMEOUT, run).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    parse(std::str::from_utf8(&out.stdout).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            login: "sam@example.com".into(),
            allowed_nodes: vec!["laptop".into(), "desk".into(), "phone".into()],
            tailnet: "example-tailnet.ts.net".into(),
            tailscale: "/nonexistent/tailscale".into(),
            machine: None,
            conn_idle: std::time::Duration::from_secs(180),
            ws_dead_after: std::time::Duration::from_secs(90),
            assistant_nodes: vec!["assistant-phone".into(), "desk".into(), "build-box".into()],
            pairs_anyway: vec!["assistant-phone".into()],
            origins: vec![],
            hc: "hc".into(),
            bind: String::new(),
            tls_bind: String::new(),
            tls: None,
            web: String::new(),
            state_dir: String::new(),
        }
    }

    fn who(name: &str, tags: &[&str], login: &str) -> Identity {
        Identity { name: name.into(), tags: tags.iter().map(|t| t.to_string()).collect(), login: login.into() }
    }

    #[test]
    fn a_listed_node_of_the_owner_is_admitted() {
        assert_eq!(decide(&cfg(), &who("phone.example-tailnet.ts.net.", &[], "sam@example.com")), Ok(()));
    }

    #[test]
    fn a_listed_tagged_node_is_admitted() {
        assert_eq!(decide(&cfg(), &who("laptop.example-tailnet.ts.net.", &["tag:desk"], "tagged-devices")), Ok(()));
    }

    #[test]
    fn anything_not_listed_is_refused_even_on_the_owners_login() {
        // A new phone, an old tablet, someone else's PC, a renamed device: all on the owner's login, none on the list.
        for name in ["old-phone", "tablet", "7762", "family-pc", "brand-new-phone"] {
            assert_eq!(decide(&cfg(), &who(&format!("{name}.example-tailnet.ts.net."), &[], "sam@example.com")), Err("node not allowed"), "{name}");
        }
    }

    #[test]
    fn other_tagged_nodes_are_refused() {
        assert!(decide(&cfg(), &who("db-host.example-tailnet.ts.net.", &["tag:server"], "tagged-devices")).is_err());
        assert!(decide(&cfg(), &who("family-laptop.example-tailnet.ts.net.", &["tag:family"], "tagged-devices")).is_err());
        // A name that only starts the same doesn't count.
        assert!(decide(&cfg(), &who("laptop-2.example-tailnet.ts.net.", &["tag:desk"], "tagged-devices")).is_err());
    }

    #[test]
    fn a_listed_name_on_someone_elses_login_is_refused() {
        assert_eq!(decide(&cfg(), &who("phone.example-tailnet.ts.net.", &[], "alex@example.com")), Err("another user's node"));
    }

    #[test]
    fn a_listed_name_from_another_tailnet_is_refused() {
        assert!(decide(&cfg(), &who("laptop.other-tailnet.example.", &["tag:desk"], "tagged-devices")).is_err());
        assert!(decide(&cfg(), &who("laptop", &["tag:desk"], "tagged-devices")).is_err());
        assert!(decide(&cfg(), &who("phone.other-tailnet.example.", &[], "sam@example.com")).is_err(), "a shared-in node, even with the owner's login");
    }

    #[test]
    fn an_empty_list_admits_nobody() {
        let mut c = cfg();
        c.allowed_nodes.clear();
        assert!(decide(&c, &who("phone.example-tailnet.ts.net.", &[], "sam@example.com")).is_err());
    }

    #[test]
    fn parses_real_whois_shapes() {
        let tagged = r#"{"Node":{"Name":"build-box.example-tailnet.ts.net.","ComputedName":"build-box","Tags":["tag:build"]},"UserProfile":{"LoginName":"tagged-devices"}}"#;
        assert_eq!(parse(tagged).unwrap().tags, vec!["tag:build"]);
        // A user-owned node has no Tags key at all.
        let owned = r#"{"Node":{"Name":"phone.example-tailnet.ts.net."},"UserProfile":{"LoginName":"sam@example.com"}}"#;
        assert!(parse(owned).unwrap().tags.is_empty());
        let null_tags = r#"{"Node":{"Name":"x.y.","Tags":null},"UserProfile":{"LoginName":"k"}}"#;
        assert!(parse(null_tags).unwrap().tags.is_empty());
    }

    #[test]
    fn unparseable_whois_is_nothing() {
        for bad in ["", "{}", "not json", r#"{"Node":{"Name":""},"UserProfile":{"LoginName":"k"}}"#, r#"{"Node":{"Name":"x"}}"#] {
            assert!(parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_tailnet_addresses_count() {
        for good in ["100.64.0.1", "100.64.0.200", "fd7a:115c:a1e0::1", "::ffff:100.64.0.25"] {
            assert!(is_tailnet(good.parse().unwrap()), "{good}");
        }
        // The top of 100.64.0.0/10, built rather than written out.
        assert!(is_tailnet(IpAddr::from([100, 127, 255, 255])));
        for bad in ["127.0.0.1", "100.63.255.255", "100.128.0.0", "198.51.100.12", "8.8.8.8", "::1", "fd7a:115c:a1e1::1"] {
            assert!(!is_tailnet(bad.parse().unwrap()), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_failed_lookup_refuses_and_is_not_cached() {
        let cache = Cache::default();
        let ip: IpAddr = "100.64.0.11".parse().unwrap();
        assert_eq!(check(&cfg(), &cache, ip).await, Err("whois failed"));
        assert!(cache.get(ip).is_none());
    }

    #[tokio::test]
    async fn a_non_tailnet_source_never_reaches_whois() {
        let cache = Cache::default();
        assert_eq!(check(&cfg(), &cache, "127.0.0.1".parse().unwrap()).await, Err("not a tailnet source"));
    }
}
