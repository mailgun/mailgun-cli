# @mailgun/cli

[![npm version](https://img.shields.io/npm/v/@mailgun/cli.svg)](https://www.npmjs.com/package/@mailgun/cli)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)

An agent-first CLI for working with Mailgun from terminals, scripts, CI systems,
and coding agents. It provides one consistent command surface for understanding
and operating a Mailgun account, with clean JSON output and a machine-readable
`agent-context` schema.

Most commands are read-only. Write commands are labeled in `agent-context` and
use the explicit, non-interactive guard described below.

> [!NOTE]
> This is an early preview. The command surface and output may still change.
> Feedback and feature requests are welcome in
> [GitHub issues](https://github.com/mailgun/mailgun-cli/issues).

## Requirements

- Node.js 20 or newer
- A Mailgun account and API key from [API security settings](https://app.mailgun.com/settings/api_security)

## Install

The CLI is published to npm as [`@mailgun/cli`](https://www.npmjs.com/package/@mailgun/cli).

```bash
npm install -g @mailgun/cli
mailgun --help
```

For a one-off run without a global install:

```bash
npx -y @mailgun/cli --help
```

In CI or a project, install it as a dependency and invoke `mailgun` from `node_modules/.bin`, or use `npx @mailgun/cli`.

## Authentication

Auth is HTTP Basic (`api:$MAILGUN_API_KEY`). Provide credentials via environment
variables or flags; flags take precedence over environment variables. API keys
are **not** region-scoped.

| Concern        | Environment variable  | Flag                                              |
| -------------- | --------------------- | ------------------------------------------------- |
| API key        | `MAILGUN_API_KEY`     | `--api-key <key>`                                 |
| Sending domain | `MAILGUN_DOMAIN`      | `--domain <domain>` (only where a domain applies) |
| API region     | `MAILGUN_API_REGION`  | `--region <us\|eu>`                               |

Region defaults to `us` (`api.mailgun.net`); `eu` routes to `api.eu.mailgun.net`.
Any value other than `us`/`eu` is a usage error.

Prefer environment variables for API keys on shared machines. Keys are redacted
from all CLI output, but flags may be captured in shell history.

Shared flags work before or after the subcommand:

```bash
mailgun metrics summary --domain acme.com --json
mailgun --domain acme.com metrics summary --json
```

## Commands

```bash
# Sending metrics summary (counts + computed rates; defaults to a 24h window)
# --duration/--window is already a lookback ending now (<number><m|h|d>, e.g. 30m, 24h, 7d) — no leading "-"
mailgun metrics summary --domain acme.com --json
mailgun metrics summary --domain acme.com --duration 7d --json
mailgun metrics summary --domain acme.com --start 2026-06-01T00:00:00Z --end 2026-06-08T00:00:00Z --json

# Validate a single address (positional or --address)
mailgun validate-email user@example.com --json
mailgun validate-email --address user@example.com --provider-lookup true --json

# Inbox placement (Optimize): discover result IDs, fetch a result, or create a test
mailgun inbox-placement list --limit 10 --json
mailgun inbox-placement result --result result_123 --json
mailgun inbox-placement result result_123 --timeout 0 --json
mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --dry-run --json
mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --yes --json
mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --timeout 0 --yes --json

# Email preview (Inspect): discover clients/tests, run QA, or resume a result
mailgun preview clients --json
mailgun preview list --limit 10 --json
mailgun preview result --test-id preview_123 --json
mailgun preview issues preview_123 --check accessibility
mailgun preview render preview_123 iphone16gmail_18 --output ./iphone.png
mailgun preview run --subject "June campaign" --html ./rendered.html --dry-run --json
mailgun preview run --subject "June campaign" --html ./rendered.html --yes --json

# Live delivery events (single fetch or continuous --tail)
mailgun events --domain acme.com --json
mailgun events --domain acme.com --tail
```

A single `mailgun events` fetch returns the most recent `--limit` events (default
10, max 100) from the last 24 hours. `--tail` shows that backlog first, then
polls forward for new events every `--interval` milliseconds:

```bash
mailgun events --domain acme.com --tail --limit 5 --interval 5000
```

## Write commands

Every write command requires exactly one of:

- `--dry-run` to validate and summarize the action without credentials or network access;
- `--yes` to execute without prompting.

Passing both or neither is a usage error (exit `2`). Commands never prompt, so
the behavior is deterministic in scripts and agent workflows.

`preview run` and `inbox-placement run` are the current write commands.
`preview run` creates one remote Mailgun Inspect preview test and consumes
preview quota. `inbox-placement run` creates one Optimize inbox placement test,
sends to seed addresses, and consumes placement quota. Neither V2 preview create
nor inbox placement create documents idempotency, so the CLI sends at most one
create request per invocation and never recreates automatically after a timeout
or uncertain outcome.

## Inbox Placement

`inbox-placement run` matches `preview run`: it creates one test, then polls until
status leaves `processing` or `--timeout` is reached (default 300 seconds).
`inbox-placement result` resumes an existing result without creating anything and
polls with a 120-second default, like `preview result`. `--timeout 0` fetches
once and returns the current state. A human TTY (without `--json`/`--quiet`)
shows a spinner while creating, then while polling. `--json` keeps stdout clean;
resume later with the returned `result_id`.

## Email Preview QA

`preview run` creates one Inspect test from a subject and HTML file, then polls
until the requested checks settle or `--timeout` is reached (default 300 seconds).
`preview result` resumes an existing test without creating anything and polls with
a 120-second default. `--timeout 0` fetches once and returns the current state.
HTML is file-only and capped at 5 MiB. Omit `--clients` to use Mailgun defaults;
`preview clients` lists IDs. `preview issues` explains one check, and
`preview render` inspects or downloads one client screenshot. JSON is a mechanical
summary with no pass/fail verdict; resume later with the returned `test_id`.

## Agent context

`agent-context` emits a machine-readable schema of the entire command surface —
flags, output fields, and examples — so agents can discover capabilities without
scraping help text:

```bash
mailgun agent-context | jq '.commands | keys'
```

## Output conventions

- `--json` emits clean, machine-readable JSON on stdout. `events --json` emits
  NDJSON (one event per line).
- Errors always go to stderr; stdout stays clean and parseable.
- `--quiet` suppresses spinners and prefixes but never the final result.
- Every normalized result includes a structured `data_gaps` array (`[]` when
  none) describing missing upstream data that affects interpretation.
- Successful-but-incomplete upstream states (e.g. `processing`, undeliverable
  addresses) exit `0` and represent status in the payload.

Exit codes:

| Code | Meaning                                                              |
| ---- | ------------------------------------------------------------------- |
| `0`  | Success (including negative or incomplete upstream outcomes)        |
| `1`  | Runtime/API/network failure                                         |
| `2`  | Usage/config error (bad input, missing key, invalid region)        |

## Product availability

Each command depends on one of Mailgun's core products: Send, Optimize,
Validate, or Inspect. Product labels are used for discovery and agent context;
actual availability is determined by the Mailgun API response at call time. A
`403` surfaces the API response body rather than a CLI-authored entitlement
claim.

## Development

```bash
git clone https://github.com/mailgun/mailgun-cli.git
cd mailgun-cli
npm install
npm run build      # type-check and compile to dist/
npm test           # compile to dist-test/ and run the test suite
npm link           # optional: expose a local `mailgun` binary on your PATH
```

Without linking, invoke a local build with `./dist/index.js <command>`.

Tests use Node's built-in runner: pure unit tests for request builders,
normalizers, and validation, plus subprocess tests that intercept the API via a
local mock server. No live credentials are required.

## Project layout

Library code lives under `src/lib/` in layers (`core/`, `cli/`, `products/`).
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full module map,
conventions, and planned growth.

## License

[Apache-2.0](LICENSE)
