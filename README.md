![Lumbridge Mobile: Your agents, from your phone.](docs/assets/banner.jpg)

# Lumbridge Mobile

Your coding agents' terminals, notes and tasks on your phone. For people who run agents in
[lumbridge-core](https://github.com/lumbridge-corp/lumbridge-core) terminals and want to answer them away from the desk. It is a
small server you run next to core, on your own tailnet, with nothing in between.

Part of [Lumbridge](https://lumbridgecorp.com) ([all repositories](https://github.com/lumbridge-corp)). In daily use.

<p align="center"><img src="docs/assets/screenshot.png" alt="The Agents screen of Lumbridge Mobile: three agents waiting on a question, an error and a permission, with one-tap answers, then the agents that are done and working." width="320"></p>

## Status

- **Version:** 0.1.0. Interfaces can change until 1.0.
- **Runs on:** the server on Linux (x86_64, aarch64). The app as an installable web app in any current browser, and as an Android app
  (Tauri). The iPhone app is the installed web app; the native iPhone build compiles but is not signed.
- **Not yet:**
  - No packaged install: you build the server and the web app from source and write its service unit yourself (an example is below).
  - Tailscale is required: the server admits only named tailnet devices.
  - No Apple push for the native iPhone shell; the installed web app gets notifications.
  - The assistant expects an OpenAI-style chat endpoint with Hermes' session headers, and your own speech services.
  - GitHub CI runs the unit tests and the server's tests; the end-to-end and browser suites run only where `lbc` and Chrome are installed.

## Install

You need: Rust (stable), Node.js 20 or later, PostgreSQL 14 or later, Tailscale, and
[lumbridge-core](https://github.com/lumbridge-corp/lumbridge-core) (`lbc` on the `PATH` of the user who runs the server).

On Ubuntu 24.04 (its `nodejs` package is 18, so take Node.js 20 or later from [nodejs.org](https://nodejs.org) or NodeSource, and Rust
from [rustup](https://rustup.rs)):

```sh
sudo apt install build-essential pkg-config postgresql
git clone https://github.com/lumbridge-corp/lumbridge-mobile.git
cd lumbridge-mobile
(cd web && npm ci && npm run build)
(cd gateway && cargo build --release)
install -m 755 gateway/target/release/lumbridge-mobile-server ~/.local/bin/
mkdir -p ~/.local/share/lumbridge-mobile && cp -r web/dist ~/.local/share/lumbridge-mobile/web
```

The database: as a Postgres admin, run `db/bootstrap.sql` once (it makes role `lumbridge_app` and schema `lumbridge`; the file says how
to pass a password verifier), then, as the server's user, `LUMBRIDGE_DATABASE_URL=postgres://lumbridge_app:...@127.0.0.1/<db> lumbridge-mobile-server migrate`.

The server stores its state (devices, push subscriptions, push keys) in `LUMBRIDGE_STATE_DIR`. To remove it, stop the service, delete the
binary, the web folder and the state folder, and drop the schema.

## The Android and iPhone apps

The native apps are a Tauri shell around the same web UI; build the web app first (`cd web && npm ci && npm run build`).

**Android** (a Linux machine with the Android SDK and NDK and a JDK 17): the default is a signed **release** APK, signed with your own
keystore. Keep the keystore and its passwords outside the repository; the script hands them to gradle through the environment and writes
neither to disk.

```sh
keytool -genkeypair -v -keystore ~/lumbridge-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias lumbridge   # once
LUMBRIDGE_ANDROID_KEYSTORE=~/lumbridge-release.jks \
LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD=... \
LUMBRIDGE_ANDROID_KEY_ALIAS=lumbridge \
  scripts/build-android.sh       # prints the APK's path; LUMBRIDGE_ANDROID_KEY_PASSWORD defaults to the store's password
```

`scripts/build-android.sh --debug` makes a debug APK for development. Don't install it on a phone you carry or give it to anyone: a debug
build is marked debuggable and its WebView can be inspected over USB, so anyone with USB access to the unlocked phone could read the device
token. Release builds turn WebView debugging off (Tauri only enables it in debug builds, and this app doesn't turn on its `devtools`
feature).

**iPhone** (a Mac with Xcode): `APPLE_DEVELOPMENT_TEAM=<team id> scripts/build-ios.sh` for a debug build on a registered iPhone, or
`--ipa` for a release `.ipa` (needs a provisioning profile).

## Quick start

A scratch instance on this machine, with its own scratch core, no tailnet check and no TLS (a `dev-identity` build). It needs `lbc`
(lumbridge-core) on the `PATH`:

```sh
(cd web && npm ci && npm run build)
scripts/dev.sh 18610           # prints a URL with a one-time device token; open it in a browser
scripts/dev.sh 18610 stop
```

You should see Today and the Agents tab, with the scratch core's `demo-shell` terminal. Notes and tasks need a database:
`scripts/dev-db.sh` starts a throwaway Postgres in a container; pass `LUMBRIDGE_DATABASE_URL` to `scripts/dev.sh`.

## Configuration

Everything is an environment variable. The ones a real install sets:

| Variable | What |
|---|---|
| `LUMBRIDGE_LOGIN` | The tailnet login whose devices are admitted |
| `LUMBRIDGE_TAILNET` | Your tailnet's DNS suffix, such as `example-tailnet.ts.net` |
| `LUMBRIDGE_ALLOWED_NODES` | Comma list of the exact tailnet names that may connect. Default deny |
| `LUMBRIDGE_ORIGINS` | Comma list of origins the browser may use, such as `https://mobile.example.com` |
| `LUMBRIDGE_TLS_BIND`, `LUMBRIDGE_TLS_CERT`, `LUMBRIDGE_TLS_KEY` | The loopback TLS listener behind `tailscale serve --tcp=443 --proxy-protocol=2`, and its certificate |
| `LUMBRIDGE_WEB` | The built web app (`web/dist`) |
| `LUMBRIDGE_STATE_DIR` | The server's own state, mode 0700 |
| `LUMBRIDGE_HC` | The `lbc` binary |
| `LUMBRIDGE_DATABASE_URL` | Notes, tasks, thoughts, asks and files. Without it those routes answer 503 and the rest works |
| `LUMBRIDGE_FILES_DIR` | Where uploaded files are kept (default `~/files`) |

The assistant, speech and drafts settings are optional and described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). An example user
unit:

```ini
[Service]
Environment=LUMBRIDGE_LOGIN=sam@example.com
Environment=LUMBRIDGE_TAILNET=example-tailnet.ts.net
Environment=LUMBRIDGE_ALLOWED_NODES=phone,laptop
Environment=LUMBRIDGE_ORIGINS=https://mobile.example.com,https://tauri.localhost,tauri://localhost
Environment=LUMBRIDGE_HC=%h/.local/bin/lbc
Environment=LUMBRIDGE_TLS_BIND=127.0.0.1:8451
Environment=LUMBRIDGE_TLS_CERT=%h/.config/lumbridge-mobile/tls/fullchain.pem
Environment=LUMBRIDGE_TLS_KEY=%h/.config/lumbridge-mobile/tls/privkey.pem
Environment=LUMBRIDGE_WEB=%h/.local/share/lumbridge-mobile/web
Environment=LUMBRIDGE_STATE_DIR=%h/.config/lumbridge-mobile/state
EnvironmentFile=-%h/.config/lumbridge-mobile/db.env
ExecStart=%h/.local/bin/lumbridge-mobile-server
Restart=on-failure
NoNewPrivileges=true
UMask=0077
```

Then `tailscale serve --bg --tcp=443 --proxy-protocol=2 tcp://127.0.0.1:8451`, and pair a device:
`lumbridge-mobile-server pair <device-name>` (with the same `LUMBRIDGE_STATE_DIR`) prints a link that works once, for ten minutes.
`lumbridge-mobile-server devices` lists devices and `revoke <name>` ends one within seconds.

| What | Path |
|---|---|
| State | `$LUMBRIDGE_STATE_DIR` (devices, push keys and subscriptions) |
| Files | `$LUMBRIDGE_FILES_DIR` |

## How it fits the system

The server speaks to lumbridge-core through `lbc connect`, the way a desktop client does; it never starts a core itself. It works alone
otherwise.

| Works with | What passes between them |
|---|---|
| [lumbridge-core](https://github.com/lumbridge-corp/lumbridge-core) | Terminal lists, screens and keystrokes, through a short allowlist of core methods |
| [lumbridge-app](https://github.com/lumbridge-corp/lumbridge-app) | Favorites and pane layouts, which the app keeps in core |

## What it sends and where

The server listens on loopback only, behind `tailscale serve`. It talks to: your core (`lbc`), your Postgres, the browser push services
of Apple and Google (for notifications, with encrypted payloads), and only if you set them, your assistant's chat endpoint and your
speech services. It sends nothing anywhere else and has no telemetry. Speech is not logged or stored by the server; a recording stays on
the phone until its text is saved. Uploaded files stay on the server host.

## Docs

- [Architecture and trust model](docs/ARCHITECTURE.md) — who gets in, what the server allows, how each part works
- [Data](docs/DATA.md) — notes, tasks, thoughts, asks, proposals and files: schema, API, client rules
- [Change log](CHANGELOG.md)

## Contributing

Bug reports and small fixes are welcome. Talk to us in an issue before a large change.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send a pull request.

```sh
scripts/ci.sh
```

The end-to-end and browser suites (they need `lbc` and Chrome, and start their own scratch cores):

```sh
eval "$(scripts/test-ports.sh)"; export LUMBRIDGE_TEST_PORT LUMBRIDGE_PG_PORT
scripts/ci-db.sh
(cd tests && npm ci)    # Playwright, used by client-regress and the browser suites
node tests/e2e.mjs "$LUMBRIDGE_TEST_PORT"
node tests/push-e2e.mjs "$LUMBRIDGE_TEST_PORT"
node tests/client-regress.mjs "$LUMBRIDGE_TEST_PORT"
scripts/ci-browser.sh "$((LUMBRIDGE_TEST_PORT + 20))"
scripts/ci-db.sh stop
```

## Security

Do not open a public issue for a security problem.
Email security@lumbridgecorp.com or use "Report a vulnerability" on this repo's Security tab.
See [SECURITY.md](SECURITY.md) and the trust model in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE).

Third-party code and assets keep their own licences: the bundled fonts' licence is in `web/src/fonts/LICENSE.txt`.
