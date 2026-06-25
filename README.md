# @mailgun/cli

Agent-first Mailgun CLI. P0 is a read-only proof-of-concept aligned with the
Mailgun MCP P0 tool set: metrics, address validation, inbox placement, and email
preview, plus a live `events` stream and machine-readable `agent-context`.

## Install / build (local)

```bash
cd mailgun-cli
npm install
npm run build      # compiles to dist/ and makes dist/index.js executable
npm link           # optional: exposes the `mailgun` binary on your PATH
```

Run without linking via `./dist/index.js <command>`.

## Authentication

Auth is HTTP Basic (`api:$MAILGUN_API_KEY`). Provide credentials via env vars or
flags; flags win over env vars. API keys are **not** region-scoped.

| Concern | Env var | Flag |
|---|---|---|
| API key | `MAILGUN_API_KEY` | `--api-key <key>` |
| Sending domain | `MAILGUN_DOMAIN` | `--domain <domain>` (only where a domain applies) |
| API region | `MAILGUN_API_REGION` | `--region <us\|eu>` |

Region defaults to `us` (`api.mailgun.net`); `eu` routes to `api.eu.mailgun.net`.
Anything other than `us`/`eu` is a usage error.

Shared flags work in either position:

```bash
mailgun metrics summary --domain acme.com --json
mailgun --domain acme.com metrics summary --json
```

## P0 commands

```bash
# Analytics metrics summary (defaults to a 24h window for MCP parity)
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
```

## Durable utility & introspection commands

```bash
# Live delivery event stream (single fetch or --tail)
mailgun events --domain acme.com --json
mailgun events --domain acme.com --tail

# Machine-readable schema of the curated command surface
mailgun agent-context | jq '.commands | keys'
```

## Output conventions

- `--json` emits clean machine-readable JSON on stdout (`events --json` is NDJSON).
- Errors always go to stderr; stdout stays clean.
- `--quiet` suppresses spinners/prefixes but never the final result.
- Every normalized output includes a structured `data_gaps` array (`[]` when none).
- Successful-but-incomplete upstream states (e.g. `processing`, undeliverable
  addresses) exit `0` and represent status in the payload.

Exit codes: `0` success (including negative/incomplete upstream outcomes),
`1` runtime/API failure, `2` usage/config error (bad input, missing key, bad region).

## Product entitlements

Each parity command depends on a Mailgun product (Analytics, Validate, Optimize,
Inspect). A `403` response is surfaced with capability-focused guidance; your
plan or API key may not include every product.

`metrics summary` defaults to a `24h` window to match the MCP `get_metrics_summary`
primitive (older human-oriented demo commands used `7d`).

## Live smoke checklist

Live smoke is a manual release gate, not part of `npm test`. With a real key:

```bash
MAILGUN_API_KEY=... MAILGUN_API_REGION=us ./dist/index.js metrics summary --domain example.com --json
MAILGUN_API_KEY=...                        ./dist/index.js validate-email --address user@example.com --json
MAILGUN_API_KEY=...                        ./dist/index.js inbox-placement list --json
MAILGUN_API_KEY=...                        ./dist/index.js inbox-placement result --result <result_id> --json
MAILGUN_API_KEY=...                        ./dist/index.js preview list --json
MAILGUN_API_KEY=...                        ./dist/index.js preview result --test-id <test_id> --json

# EU, if credentials are available
MAILGUN_API_KEY=... MAILGUN_API_REGION=eu ./dist/index.js metrics summary --domain example.eu --json
```

Record entitlement gaps (403s) rather than treating them as build failures. The
inbox-placement *result* detail shape ships with an empty OpenAPI example; live
smoke confirms its provider/placement fields.

## Tests

```bash
npm run build && npm test
```

Tests use Node's built-in runner: pure unit tests for request builders,
normalizers, and validation; mocked subprocess tests that intercept the API via a
local server. No live credentials are required for the automated suite.
