# Architecture and trust model

Lumbridge Mobile is one server (`gateway/`, Rust) and one web app (`web/`, TypeScript, no UI framework), wrapped for phones by a Tauri
shell (`app/src-tauri`). It is for one owner: no accounts, no sharing.

```text
web app (phone, computer) ─┐
                           ├─ https://mobile.example.com (tailnet only) ─ tailscale serve :443 --proxy-protocol=2
Tauri shell (Android)     ─┘        │
                             lumbridge-mobile-server (TLS, tailnet identity, device tokens)
                               ├─ /ws ─ `lbc connect` ─ lumbridge-core ─ the terminals on every machine core knows
                               ├─ /api/notes, /api/tasks, /api/thoughts, /api/files, /api/asks, /api/note-proposals ─ Postgres
                               ├─ /api/files/*/content ─ files on the server host (the bytes never go to the database)
                               ├─ /api/push ─ Web Push (Apple, Google), encrypted payloads
                               ├─ /mcp ─ notes as MCP tools, for agent devices
                               ├─ /api/assistant ─ your assistant's chat endpoint (optional)
                               ├─ /api/voice ─ your speech services (optional)
                               └─ /api/assistant/needs, /drafts, /api/mail ─ the assistant's drafts and mail rows (optional)
```

## Rules that don't bend

1. **Tailnet only.** The server listens on loopback and is reached through `tailscale serve`. Nothing is on the public internet.
2. **Core's API is a shell.** Only methods in `ALLOWED` (`gateway/src/ws.rs`) pass. Running commands, killing terminals, files and
   server control stay refused. Documents are the one narrow exception: `doc.get` passes only for the layout document lumbridge-app keeps,
   and core gets the call rebuilt from what the check read, so a repeated or extra key can't reach it. `doc.set` stays refused.
3. **Watching never resizes.** Attach with `observe: true`; the last active viewer sets a terminal's size, so a normal attach would
   reflow a desktop pane. Send with `terminal.send` / `terminal.keys`.
4. **The browser holds only a device token.** No database, assistant or speech credentials reach it. Every `/api` handler takes the
   `auth::Device` extractor.
5. **No third-party services** beyond Apple and Google push. No telemetry. Speech is never logged or stored by the server.
6. **Real cores and real terminals are never test fixtures.** Use `scripts/dev.sh`.
7. Never print, log or commit a secret.

## Who gets in

Three checks, all required, none of them enough alone. The code is `gateway/src/{listen,whois,gate,auth,devices}.rs`.

1. **Tailnet identity, before anything else.** `tailscale serve --tcp=443 --proxy-protocol=2` forwards raw TCP to the loopback TLS
   listener with a PROXY v2 header naming the source. The server asks tailscaled who that is (`tailscale whois --json <ip>`, cached 60 s,
   refusals 5 s) and decides **before the TLS handshake**. Default deny: a node gets in only if its exact name is in
   `LUMBRIDGE_ALLOWED_NODES`, it is in your tailnet (`LUMBRIDGE_TAILNET`), and it is either tagged or owned by `LUMBRIDGE_LOGIN`.
   Anything else (a missing or malformed PROXY header, a source outside the tailnet, a failed whois) gets a closed socket: no TLS, no
   page. A new device stays out until its name is added. Renaming a device takes it off.
2. **A device token.** 256 random bits per device, only its sha256 stored, in `$LUMBRIDGE_STATE_DIR/devices.json` (0600). Every `/api`
   handler and `/ws` require it, compared in constant time. Ten failures from a source block it for 5 minutes. **This token is the real
   lock: any local process on the server host can connect to the loopback listener and forge a PROXY header claiming to be an admitted
   node.** That gets it the page and `/api/pair`, not `/ws` or `/api`.
3. **Origin.** A browser's `Origin` must be in `LUMBRIDGE_ORIGINS`, for `/ws` and CORS alike.

Connections are bounded: 1024 in all, 64 per node, closed after 3 minutes with no bytes in either direction.

**Pairing.** `lumbridge-mobile-server pair <device>` on the server host makes a link `https://<host>/#pair=<code>`. The code works once,
for 10 minutes, and is stored hashed. The page posts it to `/api/pair`, which also requires admission, keeps the long-lived token and
clears the fragment, so a link in browser history is useless. Pairing a name again replaces its token. `lumbridge-mobile-server devices`
lists and `revoke <name>` revokes; the running server sees both at once, and open sessions end within 5 seconds.

**Agent devices.** A device record has a `role`: `owner` (the default) or `agent`, for a program working for the owner, such as a coding
agent. `lumbridge-mobile-server pair <name> --agent` makes its code. An agent may call only what `auth::agent_may` lists: reading notes,
proposing a note, its own proposals, and `/mcp`. Everything else, `/ws` included, is 403 `agent_not_allowed`, enforced in one place
(`gate::gate`) before any handler, so a new route is closed to agents until it is added there. An agent never gets a push. A test
(`agent_tests` in `main.rs`) reads every `.route(...)` out of the source and tries each with an agent token.

**Devices the assistant operates.** If your assistant can drive a phone or a desktop browser itself, list those nodes in
`LUMBRIDGE_ASSISTANT_NODES`. Nothing that approves, answers or mints access is accepted from them (`gateway/src/reach.rs`): a tap there
could be the assistant approving its own draft. They are judged by a fresh whois on each request, never the admission cache, and a failed
lookup is a no. `/api/pair` is refused from them too, except for the ones in `LUMBRIDGE_PAIRS_ANYWAY`, whose tokens still approve nothing.

**MCP.** `POST /mcp` (`gateway/src/mcp.rs`) is MCP over streamable HTTP with JSON answers only, with four tools: `notes_search`,
`notes_read`, `note_propose` and `my_proposals`. A proposal does nothing until the owner keeps it. Same Bearer token as the app:
`claude mcp add --transport http lumbridge-notes https://mobile.example.com/mcp --header "Authorization: Bearer <token>"`.

`dev-identity` (`scripts/dev.sh`) skips check 1 and the rate limit. It can't be built for release, binds loopback only and refuses TLS.
There, `LUMBRIDGE_DEV_NODE=<name>` makes every client that device, so a browser test can play a device the assistant operates.

TLS: any certificate for the name your devices use (for example from Let's Encrypt with a DNS challenge). The server reads the files on
each new connection, so renewing needs no restart.

## Core: the server never starts it

`lbc connect` starts a core when nobody is listening. A core started by a service at boot would give every later desktop terminal no
display and no SSH agent, so core belongs to the desktop session, and `gateway/src/hc.rs` tries core's socket before each `lbc connect`.
No answer means no `lbc` at all: `/ws` says `core_down` and the client retries quietly. Every `lbc` child gets a minimal environment, so no
secret can reach a core or its terminals.

A session has one `lbc connect`, ended by whichever comes first: the client leaving, core leaving, a revoke, 10 s without an answer to
hello, 30 s stuck sending, or 90 s of silence from the client.

## Agents and terminals

The Agents tab has two views: **By state** (`#/agents`: needs you, working, done) and **By place** (`#/panes`: machine, space, tab, pane,
read from the layout document lumbridge-app keeps in core). A blocked agent's own numbered menu, read from its screen, becomes buttons
(`views/choices.ts`). A button presses a real key in a real program and lists move under a thumb, so the first tap arms it and says what it
will do, and the second presses it, only if the screen still offers exactly that (`pressChoice` in `app.ts`). Hold-to-talk in the terminal
puts the words in the box unsent: a misheard word typed straight into an agent can't be taken back.

## The assistant (optional)

The assistant tab talks to a chat endpoint you run (`LUMBRIDGE_HERMES_URL`, OpenAI-style `/v1/chat/completions` with Hermes' session
header; its key from `LUMBRIDGE_HERMES_KEY_FILE`). One conversation continues across devices; only its id is kept on disk. Speech goes to
your own services: `LUMBRIDGE_ASR_PRIMARY_URL` and `LUMBRIDGE_ASR_FALLBACK_URL` (speech to text, with an optional vocabulary from
`LUMBRIDGE_VOICE_VOCAB_DIR`) and `LUMBRIDGE_TTS_URL` (text to speech). Requests to speech carry a private lane header so a service that
records training data can leave them out. Without these settings the tab says the assistant can't be reached and everything else works.

**Drafts.** The assistant can only draft. Its drafts are read from a JSON file (`LUMBRIDGE_NEEDS_FILE`), shown in full (anything a screen
wouldn't show but a terminal would act on is written out, `visibleText`), and carried out only when the owner presses Approve twice, by a
command you provide (`LUMBRIDGE_APPROVE_CMD`). Before running it the server asks that command for the draft's current state and refuses if it is no longer pending
or if its words are not the ones that were shown (`changed`), so retrying can't send twice and nothing unread can go. A client hears a
stable code and no tool output; neither output nor draft text is logged.

**Asks and note ideas.** The assistant asks questions through `lumbridge-mobile-server asks create` (see [DATA.md](DATA.md)); the owner
answers on the For you list, once, and the answer is handed to the assistant's conversation in the background, retried until it is taken.
Agents propose notes through `/mcp`; the owner keeps, edits or drops each one. New asks, drafts and note ideas buzz once, with words of the
server's own: nothing from them reaches a lock screen.

## Thoughts and files

**Thoughts** is the raw way in: tap to talk, tap to stop. A long recording is cut into chunks at pauses, each transcribed in order through
`/api/voice/transcribe`. Audio is written to IndexedDB on the device first, and only the server's answer to the final save removes it; a
crash costs at most the last 10 seconds. Speech or the server being down only ever means waiting. Text goes up, audio never does.

**Files** takes photos and documents. Each file goes into IndexedDB with an id chosen on the device before anything else, and only the
server's answer to its upload removes it. The bytes stay on the server host; the database keeps text about them. A filer you run
describes each file and writes back with `lumbridge-mobile-server files update`. A file marked private shows only its category until asked.

## Notifications

The server sends Web Push for: an agent that needs you, an agent that finished, and new asks, drafts and note ideas. It suppresses a push
only on positive, recent proof that you are looking at that terminal (`gateway/src/push/focus.rs`); when unsure it sends. The page closes
notifications that have been answered. Quiet hours and per-kind switches are in Settings.

## Updates reach installed clients

Files under `/assets` are named by content and cached forever; everything else is `no-store`. The service worker's cache name is stamped
per build (`web/vite.config.ts`), so each deploy is a new worker that fills its own cache, takes over and deletes the old one.
`npm run build` refuses a worker with no push handler (`web/scripts/check-sw.mjs`).

## Screens

`web/src/screens.ts` is the one list of screens. A phone gets the tabs (Today, Agents, the assistant, Tasks) and an Apps sheet for the
rest; a computer shows them all on a rail. Routes are `#/<id>` and `#/t/<address>`. An install may add screens of its own in
`web/src/ext/screens.ts` with server modules in `gateway/src/ext/`; they are compiled in when present.

## Where things live

`gateway/src`: `listen` (admission before TLS, PROXY, connection limits), `whois`, `gate` (CORS, headers, the agent gate), `auth`,
`devices`, `reach` (devices the assistant operates), `cli`, `hc` (finding core, starting `lbc connect`), `ws` (core proxy and allowlist),
`voice` (the assistant and speech), `needs` (drafts), `mail`, `data` (notes, tasks, thoughts, files, asks, proposals), `mcp`, `push`.
`web/src`: `core.ts` (core's protocol), `api.ts` (HTTP), `app.ts` (terminal state), `router.ts`, `screens.ts`, `main.ts` (the shell),
`views/*`. `db/`: numbered SQL migrations. `app/src-tauri`: the native shell. `tests/`: end-to-end suites against scratch cores.
