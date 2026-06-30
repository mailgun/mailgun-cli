# Mailgun CLI — Library Architecture

This document is the canonical map for `src/lib/`. Commands in `src/commands/` own CLI parsing, validation (Zod), and human/JSON presentation. Product modules own Mailgun API request choreography and response normalization.

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
| `products/`  | Build URLs/bodies, call API, normalize to bounded CLI shapes                                | `send/metrics.ts`, `inspect/preview.ts` |
| `workflows/` | Compose multiple product modules for agent outcomes                                         | (not implemented yet)                   |


**Conventions**

- Product modules export async fetchers and pure normalizers. They do not print to stdout.
- Commands own Zod input schemas and presentation (`--json` vs human).
- `data_gaps[].product` follows the `ProductLabel` for the module's product folder.
- Product modules import from `core/` only — no product-to-product coupling in P0.



## Current module map (MCP P0)


| CLI command              | Lib module                             | Upstream API                      |
| ------------------------ | -------------------------------------- | --------------------------------- |
| `metrics summary`        | `products/send/metrics.ts`             | `POST /v1/analytics/metrics`      |
| `events`                 | `products/send/events.ts`              | `GET /v3/{domain}/events`         |
| `validate-email`         | `products/validate/address.ts`         | `GET /v4/address/validate`        |
| `inbox-placement list`   | `products/optimize/inbox-placement.ts` | `GET /v4/inbox/results`           |
| `inbox-placement result` | `products/optimize/inbox-placement.ts` | `GET /v4/inbox/results/{id}`      |
| `preview list`           | `products/inspect/preview.ts`          | `GET /v2/preview/tests`           |
| `preview result`         | `products/inspect/preview.ts`          | `GET /v2/preview/tests/{test_id}` |


`agent-context` reads `commands/registry.ts` only — no product module.

### Send notes

Send is split across multiple capability modules because the Send OpenAPI surface spans several API families (analytics metrics, legacy events, bounce classification, suppressions, logs).

- **Events API** (`GET /v3/{domain}/events`) is deprecated in the Send OpenAPI spec in favor of **Logs** (`POST /v1/analytics/logs`). The P0 `events` command keeps the legacy endpoint; investigate workflow (future) should prefer Logs when available.
- **Message sending** (`POST /v3/{domain}/messages`) is explicitly out of CLI scope — high blast radius, SDK territory.



## Future module map (MCP P1/P2)

Documented for planning; not implemented until the corresponding command ships.


| Product   | Planned module                         | CLI commands                           | Upstream APIs                                                |
| --------- | -------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Send      | `send/bounces.ts`                      | `bounce reasons`                       | `POST /v2/bounce-classification/metrics`                     |
| Send      | `send/logs.ts`                         | investigate workflow                   | `POST /v1/analytics/logs`                                    |
| Send      | `send/suppressions.ts`                 | investigate workflow                   | `GET /v3/{domain}/bounces|unsubscribes|complaints/{address}` |
| Send      | `send/metrics.ts` (extend)             | `metrics compare`, multi-domain        | `POST /v1/analytics/metrics` (×2 or multi-filter)            |
| Optimize  | `optimize/monitoring.ts`               | `blocklist status`, reputation signals | `/v1/monitoring/*`, `/v1/maverick-score/*`                   |
| Optimize  | `optimize/inbox-placement.ts` (extend) | `inbox-placement run`                  | `POST /v4/inbox/tests`                                       |
| Inspect   | `inspect/content-checks.ts`            | `spam-risk report`                     | `/v1/inspect/links|images|accessibility|analyze/*`           |
| Inspect   | `inspect/preview.ts` (extend)          | `preview download`, `preview run`      | exports, `POST /v2/preview/tests`                            |
| Validate  | `validate/bulk.ts`                     | deferred                               | `/v4/address/validate/bulk/*`                                |
| Workflows | `workflows/preflight.ts`               | `preflight`                            | composes Validate + Optimize + Inspect modules               |
| Workflows | `workflows/investigate.ts`             | investigate (name TBD)                 | composes Send + optional Optimize                            |
| Workflows | `workflows/reputation.ts`              | `reputation overview`                  | composes Optimize monitoring + inbox result                  |




## Non-goals

The CLI aligns with the MCP v1 tool library, not the full Mailgun OpenAPI trees. Explicitly excluded:

- `POST /v3/{domain}/messages` — actual email sending
- Template/domain/webhook CRUD, billing, API key management
- Bulk suppression mutation
- OpenAPI code generation



## Adding a new command

1. Add or extend a module under `products/{product}/`.
2. Add a thin command file under `commands/` that calls the module and prints results.
3. Register the command in `commands/registry.ts`.
4. Add unit tests for normalizers/request builders co-located with the module.
5. Add CLI subprocess tests under `src/test/` when the command hits the network boundary.

