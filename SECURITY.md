# Security

Report security bugs by email to security@lumbridgecorp.com. Do not open a public issue with exploit details.

Include the commit or version you run, your OS, how the server is reached (tailnet, TLS in front, dev build), steps to reproduce, and the
impact you expect. Remove tokens, device names and addresses from logs and examples. A small reproduction helps.

The latest release and the latest `main` are supported. We answer in the same email thread. There is no fixed response deadline.

## Trust model

lumbridge-core's API is a shell: whoever can talk to it can run anything as the user who runs it. The server in `gateway/` sits in front
of it and is the only thing between a phone and those terminals, so it is the trust boundary. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
has the full rules. In short:

- **Tailnet only.** It is meant to be reached through `tailscale serve` on a tailnet, never from the public internet. Before the TLS
  handshake it asks the local tailscaled who the peer is and closes the connection unless that node's exact name is in
  `LUMBRIDGE_ALLOWED_NODES` and it belongs to `LUMBRIDGE_LOGIN` (or is tagged) in `LUMBRIDGE_TAILNET`.
- **A token per device.** Every API call and the WebSocket need a device token (256 random bits, only its hash stored). Pairing codes work
  once, for ten minutes. A device can be revoked at once from the server's command line.
- **Origin.** Browser requests must come from an origin in `LUMBRIDGE_ORIGINS`.
- **A narrow core API.** Only the core methods listed in `gateway/src/ws.rs` pass; watching attaches read-only.
- **Agent devices** may only read notes and propose new ones (`auth::agent_may`); everything else is refused before any handler runs.
- **Devices an assistant operates** (`LUMBRIDGE_ASSISTANT_NODES`) cannot approve the assistant's own drafts or answer its questions,
  whatever token they hold.
- Any local process on the server host can open the loopback listener and forge a PROXY header. The device token is the real lock.

A `dev-identity` build skips the tailnet check. It cannot be built in release mode, binds loopback only and refuses TLS. Never deploy one.
