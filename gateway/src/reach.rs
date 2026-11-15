//! The devices the assistant can operate itself, and the one question asked about them: could this request only be the owner's?
//! Whatever approves a draft or mints access goes through here. Reject doesn't: it can only take something away.
//!
//! LUMBRIDGE_ASSISTANT_NODES lists them by exact tailnet name: a phone it taps, computers whose desktops and browsers it clicks.
//! A tap from any of them could be the assistant's, whatever the page shows. LUMBRIDGE_PAIRS_ANYWAY names those of them that may
//! still be paired (a phone the owner uses that the assistant also taps). A token there opens what any token opens (terminals,
//! notes, the screens). It approves nothing: Approve and every other door behind `from_owners_hands` is judged by the node
//! asking, on each request, whatever token it holds. A machine where the assistant has a shell stays out of that list: it could
//! make the pairing code and spend it itself.

use crate::{config::Config, AppState};
use std::net::SocketAddr;

/// May this node trade a pairing code for a token? One of the owner's, or one of the assistant's listed to pair anyway.
/// No name means no.
pub fn may_pair(cfg: &Config, node: Option<&str>) -> bool {
    node.is_some_and(|n| !operated(cfg, n) || cfg.pairs_anyway.iter().any(|p| p == n))
}

/// Asked fresh, like `from_owners_hands`.
pub async fn may_pair_from(state: &AppState, peer: Option<SocketAddr>) -> bool {
    may_pair(&state.cfg, asking_node(state, peer).await.as_deref())
}

/// Only a named node that the assistant can't operate. No name means no.
pub fn only_owners(cfg: &Config, node: Option<&str>) -> bool {
    node.is_some_and(|n| !operated(cfg, n))
}

fn operated(cfg: &Config, node: &str) -> bool {
    cfg.assistant_nodes.iter().any(|a| a == node)
}

/// Asked fresh each time, never from the admission cache: a device renamed a minute ago is judged by its new name.
pub async fn from_owners_hands(state: &AppState, peer: Option<SocketAddr>) -> bool {
    only_owners(&state.cfg, asking_node(state, peer).await.as_deref())
}

#[cfg(not(feature = "dev-identity"))]
async fn asking_node(state: &AppState, peer: Option<SocketAddr>) -> Option<String> {
    crate::whois::node_name(&state.cfg, peer?.ip()).await
}

/// A dev build has no tailnet. `LUMBRIDGE_DEV_NODE` names the device every client plays, so a browser test can be one the
/// assistant operates (with LUMBRIDGE_ASSISTANT_NODES naming it); unset, they're all the owner's.
#[cfg(feature = "dev-identity")]
async fn asking_node(_: &AppState, _: Option<SocketAddr>) -> Option<String> {
    Some(std::env::var("LUMBRIDGE_DEV_NODE").unwrap_or_else(|_| "dev".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config::for_tests(std::path::Path::new("/nonexistent"))
    }

    #[test]
    fn only_devices_the_assistant_cannot_operate_count() {
        let c = cfg();
        assert!(only_owners(&c, Some("sam-phone")));
        assert!(only_owners(&c, Some("laptop")));
        for node in &c.assistant_nodes {
            assert!(!only_owners(&c, Some(node)), "{node}");
        }
        assert!(!only_owners(&c, None));
        // A name that only starts the same is another device.
        assert!(only_owners(&c, Some("build-box-2")));
    }

    #[test]
    fn a_phone_may_pair_and_still_is_not_the_owners_hands() {
        let c = cfg();
        for node in ["sam-phone", "laptop", "assistant-phone"] {
            assert!(may_pair(&c, Some(node)), "{node}");
        }
        for node in ["desk", "build-box"] {
            assert!(!may_pair(&c, Some(node)), "{node}");
        }
        assert!(!may_pair(&c, None));
        // A name that only starts the same is another device, and one of the owner's.
        assert!(may_pair(&c, Some("assistant-phone-2")));
        // Pairing gives no more than a token: every device that pairs anyway is still one the assistant operates.
        for node in &c.pairs_anyway {
            assert!(c.assistant_nodes.contains(node), "{node} is listed to pair anyway but isn't one the assistant operates");
            assert!(!only_owners(&c, Some(node)), "{node}");
        }
    }

    #[test]
    fn nothing_is_operated_unless_listed() {
        let mut c = cfg();
        c.assistant_nodes.clear();
        c.pairs_anyway.clear();
        assert!(only_owners(&c, Some("desk")) && may_pair(&c, Some("desk")));
    }
}
