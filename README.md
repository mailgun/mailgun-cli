# @mailgun/cli

An agent-first CLI for working with Mailgun from terminals, scripts, CI systems,
and coding agents. It provides one consistent command surface for understanding
and operating a Mailgun account, with clean JSON output and a machine-readable
`agent-context` schema.

Most commands are read-only. Write commands are labeled in `agent-context` and
use the explicit, non-interactive guard described below.

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
mailgun metrics summary --domain acme.com --json
mailgun metrics summary --domain acme.com --duration 7d --json
mailgun metrics summary --domain acme.com --start 2026-06-01T00:00:00Z --end 2026-06-08T00:00:00Z --json

# Validate a single address (positional or --address)
mailgun validate-email user@example.com --json
mailgun validate-email --address user@example.com --provider-lookup true --json

# Inbox placement (Optimize): discover result IDs, then fetch a result
mailgun inbox-placement list --limit 10 --json
mailgun inbox-placement result --result result_123 --json

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

`preview run` is currently the only write command. It creates one remote Mailgun
Inspect preview test and consumes preview quota. V2 does
not document create idempotency, so the CLI sends at most one create request and
never recreates automatically after a timeout or uncertain outcome.

## Email Preview QA

`preview run` accepts a subject and rendered HTML file, creates one preview test,
and polls the requested structured checks. `preview result` safely resumes an
existing test without creating anything.

After the summary, `preview issues` turns a link, image, or accessibility result
reference into individual failures with native impact, description, source
location, target/snippet, and URL where available. It fetches only the selected
check and omits passing records.

`preview render` retrieves exactly one client result. Without download flags it
lists metadata and available API-provided screenshot keys. Passing `--output`
downloads the `default` screenshot when present, otherwise another available
full screenshot before falling back to a thumbnail. `--variant` can select an
explicit key returned by the metadata call. Signed URLs are never printed;
downloads are limited to 25 MiB and refuse to overwrite an existing file.
An HTTP `425` from a screenshot asset is retried within the existing 30-second
download deadline because the asset may still be propagating; no preview test is
created or retried by this read-only operation.

- HTML is file-only; inline HTML and stdin are not accepted.
- Omitting `--clients` uses Mailgun's default client set. Use `preview clients`
  to discover explicit IDs.
- The four checks are `link_validation`, `image_validation`, `accessibility`, and
  `code_analysis`. All run by default; pass a subset or `none` explicitly.
- Check completion drives polling. Slow client screenshots do not block the
  result and are reported through client state plus a `render_incomplete` gap.
- Accessibility headline counts are issue instances; the corresponding
  `*_rules` fields count distinct rules.
- Code analysis `count` is Mailgun's `meta.count` feature total, while
  `instances` sums the reported occurrences.
- `--reference-id` is a correlation value only. It is not an idempotency key or
  a guaranteed lookup field.
- Preview HTML is limited to 5 MiB. Oversized files are rejected before a
  preview test is created.

JSON output matches the MCP composite summary: render counts and client IDs,
per-check lifecycle and references, native severity/support breakdowns,
warnings, and `data_gaps`. It deliberately contains no raw HTML, individual
issue records, or Mailgun-authored overall pass/fail verdict. Consumers define
their own gate from the reported evidence.

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
