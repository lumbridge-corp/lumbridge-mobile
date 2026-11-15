# Changelog

Lumbridge Mobile: the phone app and the server it talks to.

## [Unreleased]

## [0.1.0] - 2026-11-13

The first public release. It has been in daily use on one tailnet; this is the first version anyone else can build.

### New
- **Agents from your phone.** Every terminal of a lumbridge-core, by state (needs you, working, done) or by place (machine, space, tab).
  Answer a waiting agent's menu with two taps, open its terminal, type or hold to talk. Notifications when an agent needs you.
- **Notes, tasks, thoughts and files**, kept in your own PostgreSQL and usable offline: edits and recordings wait on the device until
  the server has them, and conflicts never overwrite anything.
- **An assistant, if you connect one**: chat by voice or text through an OpenAI-style chat endpoint (Hermes), speech-to-text and
  text-to-speech services you run, its questions and drafts in one list, and nothing it drafted is carried out until you approve it.
- **MCP for agents**: an agent device may search and read notes and propose new ones, and nothing else.
- **Android and iPhone**: a Tauri shell (`com.lumbridgecorp.mobile`) and the installable web app. `scripts/build-android.sh`
  makes a signed release APK from your own keystore; `--debug` is for development only.

### Changed (for installs that ran this before it was public)
- Settings are `LUMBRIDGE_*` environment variables. An install that used another prefix builds with `LUMBRIDGE_ENV_ALIAS=<prefix>`.
- The server is `lumbridge-mobile-server`; the assistant's routes are `/api/assistant/*`.
- SQL leaves the schema to the database role's `search_path` (`db/bootstrap.sql` makes role `lumbridge_app` and schema `lumbridge`).
  A database that ran the earlier migration files is recognised as up to date.
- Browser storage names start with `lumbridge`; an install that used another prefix builds the web app with `VITE_STORAGE_NS=<prefix>`.
