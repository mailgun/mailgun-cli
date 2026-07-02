# @mailgun/cli

An agent-first, read-only Mailgun CLI. It wraps a curated set of Mailgun
endpoints — sending metrics, address validation, inbox placement, email
preview, and a live delivery-event stream — behind a single binary with clean
JSON output and a machine-readable `agent-context` schema.

The CLI is a **read-only diagnostics and observability surface**. It never sends
email or mutates account state; every command either reads data or streams
events.

## Requirements

- Node.js 20 or newer

## Install

The CLI is not yet published to npm. Build it from source:

```bash
cd mailgun-cli
npm install
npm run build      # compiles to dist/ and marks dist/index.js executable
npm link           # optional: exposes the `mailgun` binary on your PATH
```

Without linking, invoke it directly with `./dist/index.js <command>`.

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

# Inbox placement (Optimize): discover result IDs, then fetch a result
mailgun inbox-placement list --limit 10 --json
mailgun inbox-placement result --result result_123 --json

# Email preview (Inspect): discover test IDs, then fetch a result
mailgun preview list --limit 10 --json
mailgun preview result --test-id preview_123 --json

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
npm run build      # type-check and compile to dist/
npm test           # compile to dist-test/ and run the test suite
```

Tests use Node's built-in runner: pure unit tests for request builders,
normalizers, and validation, plus subprocess tests that intercept the API via a
local mock server. No live credentials are required.

## Project layout

Library code lives under `src/lib/` in layers (`core/`, `cli/`, `products/`).
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full module map,
conventions, and planned growth.

## License

[Apache-2.0](LICENSE)
