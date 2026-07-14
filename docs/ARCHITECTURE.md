# Mailgun CLI Architecture

This document is the team-review map for `@mailgun/cli`. It explains the current command contract, module organization, extension flow, and forward review checks.

The CLI aligns with the named Mailgun MCP tool/workflow surface. The goal is a curated, durable shell-native interface for developers, CI systems, and coding agents.

## Why this exists beside MCP

The Mailgun MCP server is the preferred interface for AI assistants running inside MCP-capable clients. The CLI serves a different execution environment: terminal sessions, CI/CD, shell scripts, local debugging, and agents that can execute subprocesses but may not have an MCP server loaded.

Design intent:

- MCP provides model-native tools.
- CLI provides shell-native commands.
- CLI commands map to named MCP tools where applicable.
- The CLI follows CLI conventions for output, exit codes, and human formatting.
- Review the CLI against the named MCP library and workflow surface.

## Current command surface

| CLI command              | Product  | MCP companion                    | Upstream API                      |
| ------------------------ | -------- | -------------------------------- | --------------------------------- |
| `metrics summary`        | Send     | `get_metrics_summary`            | `POST /v1/analytics/metrics`      |
| `validate-email`         | Validate | `validate_email`                 | `GET /v4/address/validate`        |
| `inbox-placement list`   | Optimize | CLI discovery helper             | `GET /v4/inbox/results`           |
| `inbox-placement result` | Optimize | `get_inbox_placement_result`     | `GET /v4/inbox/results/{id}`      |
| `preview list`           | Inspect  | CLI discovery helper             | `GET /v2/preview/tests`           |
| `preview clients`        | Inspect  | `list_preview_clients`           | `GET /v1/preview/tests/clients`   |
| `preview result`         | Inspect  | `get_email_preview_qa`           | Preview status + check details    |
| `preview issues`         | Inspect  | Selected Inspect detail tool     | Preview status + one check detail |
| `preview render`         | Inspect  | `get_preview_client_result`      | `GET /v2/preview/tests/{id}/results/{client}` |
| `preview run`            | Inspect  | `run_email_preview_qa`           | `POST /v2/preview/tests` + reads  |
| `events`                 | Send     | CLI utility                      | `POST /v1/analytics/logs`         |
| `agent-context`          | n/a      | CLI introspection                | n/a                               |

Commands outside this table are outside the current production surface. New commands should map to the named MCP/API goal for this CLI. Command output should use Mailgun-provided fields, documented CLI-normalized fields, or stakeholder-approved workflow guidance.

`preview issues` is a read-only drill-down over exactly one requested link,
image, or accessibility result. `preview render` is a read-only single-client
lookup; when both `--variant` and `--output` are supplied, it downloads that one
image without exposing its signed URL and refuses to overwrite an existing file.

## Current architecture rules

### CLI parser

Commander.js is the current parser/router. The architecture lives in the command, product, core, and CLI modules. `agent-context` describes the registered command surface for tools and agents.

### Read/write posture

Most production commands are read-only. `preview run` is a write because it
creates a remote quota-consuming Inspect test. Every write command must use the
shared non-interactive guard: exactly one of `--dry-run` or `--yes` is required.
Dry runs need no credentials and make no requests; execution never prompts.

### Authentication and runtime inputs

Credentials and runtime inputs come from environment variables or flags:

- `MAILGUN_API_KEY`
- `MAILGUN_DOMAIN`
- `MAILGUN_API_REGION`

This keeps runtime behavior explicit for CI, containers, and agent execution.

### API host routing

The public CLI supports region routing only:

- `us` -> `api.mailgun.net`
- `eu` -> `api.eu.mailgun.net`

Public host selection is region-based. Subprocess tests use `MAILGUN_TEST_BASE_URL` only when `NODE_ENV=test`; this is test infrastructure.

### Structured gaps over warnings

Every normalized output includes `data_gaps: []` when complete, or structured objects when interpretation is limited:

- `code`
- `product`
- `message`
- `impact`

This gives humans and agents a stable way to reason about partial upstream data.

### Raw output

The current public output contract is normalized fields only. Live smoke testing should identify whether any future raw passthrough option belongs in the CLI.

## Layer model

```
src/lib/
  core/           HTTP transport, runtime context, shared types
  cli/            Output, spinners, shared arg helpers
  products/       Product API modules (request + normalize)
    send/
    validate/
    optimize/
    inspect/
  workflows/      (future) cross-product orchestration
```

| Layer        | Responsibility                                                                              | Examples                                |
| ------------ | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| `core/`      | Region routing, auth headers, `mailgunRequest`, `resolveRuntime`, `ProductLabel`, `DataGap` | `mailgun.ts`, `runtime.ts`, `types.ts`  |
| `cli/`       | Exit codes, stdout/stderr discipline, spinners, `--limit` parsing                           | `output.ts`, `spinner.ts`, `input.ts`   |
| `products/`  | Build URLs/bodies, call API, normalize to bounded CLI shapes                                | `send/metrics.ts`, `send/logs.ts`       |
| `workflows/` | Compose multiple product modules for agent outcomes                                         | planned                                 |

## Module conventions

- Product modules own Mailgun request details and response normalization.
- Command modules own stdout and stderr writes.
- Command modules own CLI input, validation, output formatting, and `agent-context` descriptors.
- Keep command descriptors beside the command registration so command behavior and agent metadata change together.
- `commands/registry.ts` only collects descriptors from command modules.
- Keep product modules independent from each other; put shared behavior in `core/` or `cli/`.

## Send notes

Send is split across capability modules because the Send OpenAPI surface spans several API families: analytics metrics, event logs, bounce classification, suppressions, and message sending.

- `mailgun events` is the CLI workflow for inspecting delivery activity. It is backed by **Logs** (`POST /v1/analytics/logs`) because the older Events API (`GET /v3/{domain}/events`) is deprecated in the Send OpenAPI spec. The command keeps the `events` name because that matches the user task; the product module is `send/logs.ts` because that matches the Mailgun API surface.
- **Message sending** (`POST /v3/{domain}/messages`) belongs in SDKs or explicitly approved write-command work.

## Output and error contract

Important invariants:

- `--json` emits clean machine-readable JSON on stdout.
- `events --json` emits NDJSON.
- Errors always go to stderr.
- API keys must never appear in output, logs, examples, fixtures, or errors.
- `--quiet` suppresses incidental output but not the final result.
- Exit `0`: successful command, including negative or incomplete upstream outcomes.
- Exit `1`: runtime/API/network/unexpected server failure.
- Exit `2`: usage/config error.
- 403 responses include the failed operation and upstream API response body.

## Product behavior notes

### `mailgun metrics summary`

- CLI equivalent of MCP `get_metrics_summary`.
- Uses `POST /v1/analytics/metrics`.
- Defaults to `duration=24h`.
- Supports `--window` as a CLI alias for `duration`.
- Supports `--duration`, `--start`, `--end`, and `--timezone`.
- Includes resolved single `domain` in output for provenance.
- Output includes upstream metrics, computed rates, resolved domain, data gaps, and the requested window.

### `mailgun validate-email`

- CLI equivalent of MCP `validate_email`.
- Uses `GET /v4/address/validate`.
- Supports positional address or `--address`.
- Supports `--provider-lookup true|false`.
- Output includes upstream `result`, `risk`, reasons, and provider lookup fields when present.

### `mailgun inbox-placement result`

- CLI equivalent of MCP `get_inbox_placement_result`.
- Uses `GET /v4/inbox/results/{result}`.
- Normalizes aggregate placement and provider placement.
- Supports the `--provider` API query filter.

### `mailgun preview result`

- CLI equivalent of MCP `get_email_preview_qa`.
- Polls `GET /v2/preview/tests/{test_id}`, then retrieves referenced link,
  image, accessibility, and code-analysis detail payloads.
- Normalizes render state, check lifecycle, counts, references, warnings, and
  data gaps without producing a pass/fail verdict.
- Requested checks drive completion; client rendering never blocks the result.
- Missing check references remain processing until the deadline. A detail 404
  becomes unavailable evidence; all other detail failures remain runtime errors.

### `mailgun preview run`

- CLI equivalent of MCP `run_email_preview_qa` and the only current write command.
- Accepts rendered HTML from a file and sends at most one create POST.
- Requires exactly one of `--dry-run` or `--yes`; never prompts.
- Defaults to all four checks and Mailgun's default clients.
- Threads the explicit check/client selection through normalization so omitted
  upstream evidence cannot silently disappear.
- Treats `reference_id` as correlation only, never idempotency or guaranteed lookup.

### `mailgun events`

- Durable Send utility for single-fetch or tailing delivery events.
- Uses `POST /v1/analytics/logs` through `send/logs.ts`.
- Keeps `--domain` required and sends it as a Logs domain filter.
- Defaults the initial fetch/backlog to a 24-hour Logs window.
- Limits `--limit` to 100 to match the Logs pagination contract.
- `--json` emits NDJSON.
- `--tail` shows a recent backlog, then polls forward with ascending Logs queries and pagination tokens.
- Event output is normalized delivery activity. Future investigation workflows can layer Mailgun-approved interpretation on top of this event stream.

## Future module map

Documented for planning. Move an item into the current command surface when the corresponding command ships.

| Product   | Planned module                         | CLI commands                           | Upstream APIs                                                |
| --------- | -------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Send      | `send/bounces.ts`                      | `bounce reasons`                       | `POST /v2/bounce-classification/metrics`                     |
| Send      | `send/logs.ts` (extend)                | investigate workflow                   | `POST /v1/analytics/logs`                                    |
| Send      | `send/suppressions.ts`                 | investigate workflow                   | `GET /v3/{domain}/bounces|unsubscribes|complaints/{address}` |
| Send      | `send/metrics.ts` (extend)             | `metrics compare`, multi-domain        | `POST /v1/analytics/metrics`                                 |
| Optimize  | `optimize/monitoring.ts`               | `blocklist status`, reputation signals | `/v1/monitoring/*`, `/v1/maverick-score/*`                   |
| Optimize  | `optimize/inbox-placement.ts` (extend) | `inbox-placement run`                  | `POST /v4/inbox/tests`                                       |
| Inspect   | `inspect/content-checks.ts`            | `spam-risk report`                     | `/v1/inspect/links|images|accessibility|analyze/*`           |
| Inspect   | `inspect/preview.ts` (extend)          | `preview download`                     | exports                                                       |
| Validate  | `validate/bulk.ts`                     | future bulk validation                 | `/v4/address/validate/bulk/*`                                |
| Workflows | `workflows/preflight.ts`               | `preflight`                            | composes Validate + Optimize + Inspect modules               |
| Workflows | `workflows/investigate.ts`             | investigate (name TBD)                 | composes Send + optional Optimize                            |
| Workflows | `workflows/reputation.ts`              | `reputation overview`                  | composes Optimize monitoring + inbox result                  |

## Current Boundaries

The CLI is a curated command surface aligned with the MCP v1 tool library. Current boundaries:

- `POST /v3/{domain}/messages` - actual email sending
- Template/domain/webhook CRUD, billing, API key management
- Bulk suppression mutation
- OpenAPI code generation
- Public arbitrary API host overrides
- Runtime fixture modes in production command paths

## Adding a new command

Use this flow for new production commands:

1. Add or extend a module under `src/lib/products/{product}/`.
2. Add unit tests for request builders and normalizers beside the product module.
3. Add a thin command file under `src/commands/` that calls the product module and prints results.
4. Export command descriptors beside the Commander registration.
5. Aggregate descriptors in `src/commands/registry.ts`.
6. Register the command group in `src/index.ts`.
7. Add CLI subprocess tests under `src/test/` when the command hits the network seam.
8. Update this document and README examples if the command is now shipped surface.

### Example: adding `bounce reasons`

`bounce reasons` is a Send diagnostic command. A contributor would:

1. Add `src/lib/products/send/bounces.ts`.
2. Add `src/lib/products/send/bounces.test.ts`.
3. Add `src/commands/bounce.ts`.
4. Export `BOUNCE_DESCRIPTORS` beside `registerBounce`.
5. Import and spread `BOUNCE_DESCRIPTORS` in `src/commands/registry.ts`.
6. Import and call `registerBounce(program)` in `src/index.ts`.
7. Add subprocess coverage in `src/test/bounce.cli.test.ts`.
8. Move `send/bounces.ts` from the future map to the current command surface in this document.

The descriptor should describe the externally visible command, not the internal Mailgun endpoint:

```ts
export const BOUNCE_DESCRIPTORS: CommandDescriptor[] = [
  {
    command: 'bounce reasons',
    mode: 'read',
    product: 'Send',
    mcpTool: 'get_top_bounce_reasons',
    description: 'List top bounce reasons for a domain and window',
    flags: ['--domain', '--duration', '--start', '--end', '--timezone', '--region', '--json', '--quiet'],
    outputFields: ['domain', 'reasons', 'data_gaps', 'window'],
    examples: ['mailgun bounce reasons --domain acme.com --duration 7d --json']
  }
];
```

Keep the command module as a CLI adapter. It can parse flags, validate input, start/stop spinners, and print human or JSON output. The product module owns request shape, upstream API paths, response normalization, and data gaps.

## Forward review checks

Before release or before expanding the command surface, review:

- Confirm the Inspect Preview v2 endpoint against current Mailgun guidance and update MCP/spec references if needed.
- Confirm whether `inbox-placement result --provider` should remain in the current read-only surface.
- Confirm whether discovery filters on `preview list` and `inbox-placement list` should remain or be trimmed to minimal ID-finding helpers.
- Run live smoke tests with real credentials for each product surface.
- Confirm live Logs tailing behavior against real event volume, especially start/end polling windows and pagination tokens.
- Decide whether the current `NODE_ENV=test` host substitution should remain or become an explicit test transport adapter.
- Re-run package verification so only production `dist/` files ship.
