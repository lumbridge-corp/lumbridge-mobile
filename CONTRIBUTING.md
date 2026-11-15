# Contributing

Report bugs and request features as issues in this repository. Discuss bigger changes there before writing a PR. Report security bugs by
email instead: see [SECURITY.md](SECURITY.md). Keep PRs small and add tests for behaviour changes.

The server is a trust boundary in front of a shell (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). A change to `gateway/src/{listen,whois,gate,auth,devices,ws,reach}.rs`
needs a test that shows what is refused, not only what works.

## Setup

Rust (stable), Node.js 20 or later, and PostgreSQL 14 or later (CI uses 16) binaries for the data tests. The browser suites also need Google Chrome and a
built `lbc` from [lumbridge-core](https://github.com/lumbridge-corp/lumbridge-core) on the `PATH`.

## Checks

```sh
scripts/ci.sh
```

runs what CI runs: the scrub check, the web app's type check, unit tests and build, and the server's clippy and tests against a throwaway
Postgres. The end-to-end and browser suites are listed in the README; they start their own scratch cores and never touch real ones.

Before a PR, run `scripts/scrub-check`. It fails on private network addresses, home folders, email addresses and token formats that are
not listed in `.scrub-allow`. Use made-up examples: user `sam`, host `desk`, `example.com`, tailnet addresses `100.64.0.x`.

PRs target `main`. Write what users will notice in CHANGELOG.md. By sending a PR you agree that your change is licensed under Apache-2.0,
like the rest of the project.
