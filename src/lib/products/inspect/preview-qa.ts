import { performance } from 'node:perf_hooks';
import type { DataGap } from '../../core/types.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';
import {
  CHECK_NAMES,
  checkResultPath,
  detailStatus,
  extractCheckResultIds,
  type CheckName,
  type CheckReference
} from './preview-checks.js';
import { asArray, asRecord, stringArray, stringOrNull } from './preview-values.js';

// Email Preview QA summary, mirroring the MCP composite output field-for-field:
// the same upstream payloads normalize to the same counts, references, lifecycle
// states, and data-gap codes. Mechanical counts and references only, no verdict.

export type RenderStatus = 'complete' | 'processing' | 'partial' | 'unknown';

export type CheckLifecycle =
  | 'not_requested'
  | 'processing'
  | 'complete'
  | 'job_failed'
  | 'unavailable';

export interface PreviewWarning {
  name: string | null;
  message: string | null;
}

export interface LinkImageCheckSummary {
  status: CheckLifecycle;
  result_id: string | null;
  passes: number;
  failures: number;
  informational: number;
  by_severity: Record<string, number>;
}

export interface AccessibilityCheckSummary {
  status: CheckLifecycle;
  result_id: string | null;
  // Headline counts are instance-level; *_rules are distinct-rule counts.
  failures: number;
  failure_rules: number;
  needs_review: number;
  needs_review_rules: number;
  failures_by_severity: Record<string, number>;
  needs_review_by_severity: Record<string, number>;
}

// Passed through from the analyze `meta` block; not recomputed.
export type SupportBreakdown = Record<string, unknown>;

export interface CodeAnalysisCheckSummary {
  status: CheckLifecycle;
  result_id: string | null;
  // count = analyze meta.count (feature total); instances = sum of occurrences.
  count: number;
  instances: number;
  by_feature: Record<string, number>;
  application_support: SupportBreakdown;
  inbox_provider_support: SupportBreakdown;
  market_support: SupportBreakdown;
}

export interface PreviewQaOutput {
  test_id: string;
  status: RenderStatus;
  timed_out: boolean;
  summary: { total_clients: number; completed: number; processing: number; bounced: number };
  clients: { completed: string[]; processing: string[]; bounced: string[] };
  checks: {
    link_validation: LinkImageCheckSummary;
    image_validation: LinkImageCheckSummary;
    accessibility: AccessibilityCheckSummary;
    code_analysis: CodeAnalysisCheckSummary;
  };
  issue_counts: {
    total: number;
    by_check: Record<string, number>;
    by_severity: Record<string, number>;
    by_check_and_severity: Record<string, Record<string, number>>;
  };
  warnings: PreviewWarning[];
  data_gaps: DataGap[];
}

export type PreviewRunFailureKind = 'create_uncertain' | 'create_missing_id' | 'poll_failed';

// Structured workflow failure for the command layer to render. Product code
// records what happened; shell-specific recovery wording remains in commands/.
export class PreviewRunError extends Error {
  readonly kind: PreviewRunFailureKind;
  readonly statusCode?: number;
  readonly testId?: string;
  readonly referenceId?: string;
  readonly detail?: string;

  constructor(params: {
    kind: PreviewRunFailureKind;
    statusCode?: number;
    testId?: string;
    referenceId?: string;
    detail?: string;
  }) {
    super(params.kind);
    this.name = 'PreviewRunError';
    this.kind = params.kind;
    this.statusCode = params.statusCode;
    this.testId = params.testId;
    this.referenceId = params.referenceId;
    this.detail = params.detail;
  }
}

const PRODUCT = 'Inspect' as const;

// Preserve native severity/impact spelling and casing. Blank/missing buckets as unknown.
function severityBucket(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : 'unknown';
}

function increment(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

// --- render state ---

export interface RenderState {
  status: RenderStatus;
  completed: string[];
  processing: string[];
  bounced: string[];
}

export function normalizeRenderState(render: unknown): RenderState {
  const record = asRecord(render);
  const completed = stringArray(record.completed);
  const processing = stringArray(record.processing);
  const bounced = stringArray(record.bounced);

  let status: RenderStatus;
  if (completed.length + processing.length + bounced.length === 0) status = 'unknown';
  else if (processing.length > 0) status = 'processing';
  else if (bounced.length > 0) status = 'partial';
  else status = 'complete';

  return { status, completed, processing, bounced };
}

// --- check fetch outcome ---

export type CheckFetchStatus = 'ok' | 'not_found' | 'not_fetched';

export interface CheckFetch {
  status: CheckFetchStatus;
  payload?: unknown;
}

// A requested check is terminal once its job errored, its detail is complete, or
// its endpoint is unavailable. Independent of per-client rendering.
export function isCheckTerminal(ref: CheckReference, fetch: CheckFetch): boolean {
  if (!ref.requested) return true;
  if (ref.hasErrors) return true;
  if (ref.resultId === null) return false;
  if (fetch.status === 'ok') return detailStatus(fetch.payload) !== 'processing';
  if (fetch.status === 'not_found') return true;
  return false; // not_fetched
}

// A missing requested reference remains processing until the workflow deadline.
export function normalizeCheckLifecycle(ref: CheckReference, fetch: CheckFetch): CheckLifecycle {
  if (!ref.requested) return 'not_requested';
  if (ref.hasErrors) return 'job_failed';
  if (ref.resultId === null) return 'processing';
  if (fetch.status === 'ok') return detailStatus(fetch.payload) === 'processing' ? 'processing' : 'complete';
  if (fetch.status === 'not_found') return 'unavailable';
  return 'processing'; // requested, referenced, but not fetched by the deadline
}

// --- issue counters ---

interface LinkImageCounts {
  passes: number;
  failures: number;
  informational: number;
  by_severity: Record<string, number>;
}

function countFindingBuckets(entries: unknown[]): LinkImageCounts {
  const counts: LinkImageCounts = { passes: 0, failures: 0, informational: 0, by_severity: {} };
  for (const entry of entries) {
    const record = asRecord(entry);
    counts.passes += asArray(record.passes).length;
    counts.informational += asArray(record.informational).length;
    const failures = asArray(record.failures);
    counts.failures += failures.length;
    for (const failure of failures) {
      increment(counts.by_severity, severityBucket(asRecord(failure).impact));
    }
  }
  return counts;
}

export function countLinkValidationIssues(payload: unknown): LinkImageCounts {
  return countFindingBuckets(asArray(asRecord(asRecord(payload).items).results));
}

export function countImageValidationIssues(payload: unknown): LinkImageCounts {
  return countFindingBuckets(asArray(asRecord(asRecord(payload).items).images));
}

interface AccessibilityCounts {
  failures: number;
  failure_rules: number;
  needs_review: number;
  needs_review_rules: number;
  failures_by_severity: Record<string, number>;
  needs_review_by_severity: Record<string, number>;
}

// Rules carry an instances[] array. Count instances as the headline and rules as
// a secondary signal; a rule with no instances[] counts as one occurrence.
function countRuleGroups(
  entries: unknown[]
): { instances: number; rules: number; bySeverity: Record<string, number> } {
  let instances = 0;
  let rules = 0;
  const bySeverity: Record<string, number> = {};
  for (const entry of entries) {
    const record = asRecord(entry);
    const occurrences = asArray(record.instances);
    const n = occurrences.length > 0 ? occurrences.length : 1;
    rules += 1;
    instances += n;
    increment(bySeverity, severityBucket(record.impact), n);
  }
  return { instances, rules, bySeverity };
}

export function countAccessibilityIssues(payload: unknown): AccessibilityCounts {
  const counts: AccessibilityCounts = {
    failures: 0,
    failure_rules: 0,
    needs_review: 0,
    needs_review_rules: 0,
    failures_by_severity: {},
    needs_review_by_severity: {}
  };
  for (const group of asArray(asRecord(payload).items)) {
    const record = asRecord(group);
    const f = countRuleGroups(asArray(record.failures));
    counts.failures += f.instances;
    counts.failure_rules += f.rules;
    for (const [sev, n] of Object.entries(f.bySeverity)) increment(counts.failures_by_severity, sev, n);

    const r = countRuleGroups(asArray(record.needs_review));
    counts.needs_review += r.instances;
    counts.needs_review_rules += r.rules;
    for (const [sev, n] of Object.entries(r.bySeverity)) increment(counts.needs_review_by_severity, sev, n);
  }
  return counts;
}

interface CodeAnalysisCounts {
  count: number | null;
  instances: number;
  by_feature: Record<string, number>;
  application_support: Record<string, unknown>;
  inbox_provider_support: Record<string, unknown>;
  market_support: Record<string, unknown>;
}

// meta.count is the canonical total (feature count); meta.*_support pass through
// verbatim. instances/by_feature are derived from items.features for drill-down.
export function countCodeAnalysisIssues(payload: unknown): CodeAnalysisCounts {
  const meta = asRecord(asRecord(payload).meta);
  const features = asArray(asRecord(asRecord(payload).items).features);

  const by_feature: Record<string, number> = {};
  let instances = 0;
  for (const feature of features) {
    const record = asRecord(feature);
    const slug = stringOrNull(record.slug) ?? stringOrNull(record.name) ?? 'unknown';
    const instanceCount = asArray(record.instances).length;
    increment(by_feature, slug, instanceCount);
    instances += instanceCount;
  }

  const count = typeof meta.count === 'number' && Number.isFinite(meta.count) ? meta.count : null;

  return {
    count,
    instances,
    by_feature,
    application_support: asRecord(meta.application_support),
    inbox_provider_support: asRecord(meta.inbox_provider_support),
    market_support: asRecord(meta.market_support)
  };
}

// --- warnings ---

export function normalizeWarnings(create: unknown): PreviewWarning[] {
  return asArray(asRecord(create).warnings).map((w) => {
    const record = asRecord(w);
    return { name: stringOrNull(record.name), message: stringOrNull(record.message) };
  });
}

// --- create request (used by `preview run`) ---

export interface PreviewCreateInput {
  subject: string;
  html: string;
  clients?: readonly string[];
  // Undefined defaults to all four; an empty array means 'no checks'.
  contentChecks?: readonly CheckName[];
  referenceId?: string;
}

// Body for POST /v2/preview/tests. HTML-only source; content_checking sends
// explicit booleans for all four; clients/reference_id omitted when absent.
export function buildPreviewCreateRequest(input: PreviewCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = { subject: input.subject, html: input.html };
  if (input.clients && input.clients.length > 0) body.clients = [...input.clients];

  const requested = input.contentChecks ?? CHECK_NAMES;
  const contentChecking: Record<string, boolean> = {};
  for (const name of CHECK_NAMES) contentChecking[name] = requested.includes(name);
  body.content_checking = contentChecking;

  if (input.referenceId) body.reference_id = input.referenceId;
  return body;
}

export function extractCreatedTestId(created: unknown): string | null {
  return stringOrNull(asRecord(created).id);
}

// --- output builder (pure) ---

export interface BuildOutputParams {
  testId: string;
  render: unknown;
  refs: Record<CheckName, CheckReference>;
  fetches: Record<CheckName, CheckFetch>;
  timedOut: boolean;
  warnings?: PreviewWarning[];
  requestedClients?: readonly string[];
}

export function buildPreviewQaOutput(params: BuildOutputParams): PreviewQaOutput {
  const { testId, render, refs, fetches, timedOut } = params;
  const renderState = normalizeRenderState(render);
  const dataGaps: DataGap[] = [];

  if (renderState.status === 'unknown') {
    dataGaps.push({
      code: 'render_clients_unavailable',
      product: PRODUCT,
      message: 'No client rendering state was returned for this test.',
      impact: 'Per-client completion status becomes available once the preview finishes processing.'
    });
  } else if (renderState.processing.length > 0) {
    // Slow/stuck client renders don't block results; report as a non-fatal gap (like the Inspect UI).
    dataGaps.push({
      code: 'render_incomplete',
      product: PRODUCT,
      message: `${renderState.processing.length} client render(s) had not finished when results were returned.`,
      impact:
        'Screenshot rendering for some clients is still processing; content checks are unaffected. Resume with the same test id to collect the remaining renders.'
    });
  }

  if (params.requestedClients) {
    const presentClients = new Set([
      ...renderState.completed,
      ...renderState.processing,
      ...renderState.bounced
    ]);
    const missingClients = params.requestedClients.filter((client) => !presentClients.has(client));
    if (missingClients.length > 0) {
      dataGaps.push({
        code: 'requested_client_missing',
        product: PRODUCT,
        message: `${missingClients.length} requested client(s) did not appear in any render state: ${missingClients.join(', ')}.`,
        impact: 'Per-client render evidence for these requested clients is unavailable.'
      });
    }
  }

  const lifecycleFor = (name: CheckName): CheckLifecycle =>
    normalizeCheckLifecycle(refs[name], fetches[name]);

  const addRefGap = (name: CheckName, lifecycle: CheckLifecycle): void => {
    if (refs[name].requested && refs[name].resultId === null && timedOut) {
      dataGaps.push({
        code: 'check_reference_missing',
        product: PRODUCT,
        message: `The ${name} check did not expose a result reference before the workflow deadline.`,
        impact: `Detailed ${name} results are not yet available; resume with the same test id.`
      });
    } else if (lifecycle === 'unavailable' && refs[name].requested) {
      dataGaps.push({
        code: 'result_endpoint_unavailable',
        product: PRODUCT,
        message: `The ${name} result endpoint was unavailable.`,
        impact: `Detailed ${name} results could not be retrieved and are not counted.`
      });
    }
  };

  const linkLifecycle = lifecycleFor('link_validation');
  addRefGap('link_validation', linkLifecycle);
  const linkCounts =
    linkLifecycle === 'complete'
      ? countLinkValidationIssues(fetches.link_validation.payload)
      : { passes: 0, failures: 0, informational: 0, by_severity: {} };

  const imageLifecycle = lifecycleFor('image_validation');
  addRefGap('image_validation', imageLifecycle);
  const imageCounts =
    imageLifecycle === 'complete'
      ? countImageValidationIssues(fetches.image_validation.payload)
      : { passes: 0, failures: 0, informational: 0, by_severity: {} };

  const a11yLifecycle = lifecycleFor('accessibility');
  addRefGap('accessibility', a11yLifecycle);
  const a11yCounts =
    a11yLifecycle === 'complete'
      ? countAccessibilityIssues(fetches.accessibility.payload)
      : {
          failures: 0,
          failure_rules: 0,
          needs_review: 0,
          needs_review_rules: 0,
          failures_by_severity: {},
          needs_review_by_severity: {}
        };

  const codeLifecycle = lifecycleFor('code_analysis');
  addRefGap('code_analysis', codeLifecycle);
  const codeCounts: CodeAnalysisCounts =
    codeLifecycle === 'complete'
      ? countCodeAnalysisIssues(fetches.code_analysis.payload)
      : {
          count: 0,
          instances: 0,
          by_feature: {},
          application_support: {},
          inbox_provider_support: {},
          market_support: {}
        };

  if (codeLifecycle === 'complete' && codeCounts.count === null) {
    dataGaps.push({
      code: 'code_analysis_count_unavailable',
      product: PRODUCT,
      message: 'The code analysis result did not include a usable meta.count total.',
      impact: 'The feature total is unavailable; per-feature instance counts are still reported.'
    });
  }

  if (timedOut) {
    dataGaps.push({
      code: 'workflow_timed_out',
      product: PRODUCT,
      message: 'The workflow deadline was reached while work was still processing.',
      impact: 'Some render or check results may be incomplete; resume with the same test id.'
    });
  }

  const byCheck: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byCheckAndSeverity: Record<string, Record<string, number>> = {};

  const foldFailures = (name: string, failures: number, bySev: Record<string, number>): void => {
    if (failures > 0) byCheck[name] = failures;
    for (const [sev, count] of Object.entries(bySev)) {
      increment(bySeverity, sev, count);
      byCheckAndSeverity[name] = byCheckAndSeverity[name] ?? {};
      increment(byCheckAndSeverity[name], sev, count);
    }
  };
  foldFailures('link_validation', linkCounts.failures, linkCounts.by_severity);
  foldFailures('image_validation', imageCounts.failures, imageCounts.by_severity);
  foldFailures('accessibility', a11yCounts.failures, a11yCounts.failures_by_severity);

  const totalIssues = linkCounts.failures + imageCounts.failures + a11yCounts.failures;

  return {
    test_id: testId,
    status: renderState.status,
    timed_out: timedOut,
    summary: {
      total_clients:
        renderState.completed.length + renderState.processing.length + renderState.bounced.length,
      completed: renderState.completed.length,
      processing: renderState.processing.length,
      bounced: renderState.bounced.length
    },
    clients: {
      completed: renderState.completed,
      processing: renderState.processing,
      bounced: renderState.bounced
    },
    checks: {
      link_validation: {
        status: linkLifecycle,
        result_id: refs.link_validation.resultId,
        passes: linkCounts.passes,
        failures: linkCounts.failures,
        informational: linkCounts.informational,
        by_severity: linkCounts.by_severity
      },
      image_validation: {
        status: imageLifecycle,
        result_id: refs.image_validation.resultId,
        passes: imageCounts.passes,
        failures: imageCounts.failures,
        informational: imageCounts.informational,
        by_severity: imageCounts.by_severity
      },
      accessibility: {
        status: a11yLifecycle,
        result_id: refs.accessibility.resultId,
        failures: a11yCounts.failures,
        failure_rules: a11yCounts.failure_rules,
        needs_review: a11yCounts.needs_review,
        needs_review_rules: a11yCounts.needs_review_rules,
        failures_by_severity: a11yCounts.failures_by_severity,
        needs_review_by_severity: a11yCounts.needs_review_by_severity
      },
      code_analysis: {
        status: codeLifecycle,
        result_id: refs.code_analysis.resultId,
        count: codeCounts.count ?? 0,
        instances: codeCounts.instances,
        by_feature: codeCounts.by_feature,
        application_support: codeCounts.application_support,
        inbox_provider_support: codeCounts.inbox_provider_support,
        market_support: codeCounts.market_support
      }
    },
    issue_counts: {
      total: totalIssues,
      by_check: byCheck,
      by_severity: bySeverity,
      by_check_and_severity: byCheckAndSeverity
    },
    warnings: params.warnings ?? [],
    data_gaps: dataGaps
  };
}

// --- polling orchestration (I/O injected for deterministic tests) ---

export type RequestFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface PollDeps {
  request: RequestFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface PollParams {
  testId: string;
  timeoutMs: number;
  intervalMs?: number;
  requestedChecks?: ReadonlySet<CheckName>;
}

export interface PollResult {
  render: unknown;
  refs: Record<CheckName, CheckReference>;
  fetches: Record<CheckName, CheckFetch>;
  timedOut: boolean;
}

const POLL_INTERVAL_MS = 5000;

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 404;
}

// Fetch referenced check results concurrently (at most four). Unreferenced or
// errored checks are left unfetched.
async function fetchCheckResults(
  refs: Record<CheckName, CheckReference>,
  deps: PollDeps
): Promise<Record<CheckName, CheckFetch>> {
  const fetches = {} as Record<CheckName, CheckFetch>;
  await Promise.all(
    CHECK_NAMES.map(async (name) => {
      const ref = refs[name];
      if (!ref.requested || ref.hasErrors || ref.resultId === null) {
        fetches[name] = { status: 'not_fetched' };
        return;
      }
      try {
        const payload = await deps.request('GET', checkResultPath(name, ref.resultId));
        fetches[name] = { status: 'ok', payload };
      } catch (error) {
        if (isNotFound(error)) fetches[name] = { status: 'not_found' };
        else throw error;
      }
    })
  );
  return fetches;
}

// Poll until every requested check is terminal or the deadline passes. Completion
// is driven by checks, not per-client rendering (a slow client never blocks).
export async function pollPreviewQa(params: PollParams, deps: PollDeps): Promise<PollResult> {
  const interval = params.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = deps.now() + params.timeoutMs;
  const statusPath = `/v2/preview/tests/${encodeURIComponent(params.testId)}`;

  let render: unknown = await deps.request('GET', statusPath);
  let refs = extractCheckResultIds(render, params.requestedChecks);
  let fetches = await fetchCheckResults(refs, deps);
  let timedOut = false;

  const allChecksTerminal = (): boolean =>
    CHECK_NAMES.every((name) => isCheckTerminal(refs[name], fetches[name]));

  while (!allChecksTerminal()) {
    if (deps.now() + interval > deadline) {
      timedOut = true;
      break;
    }
    await deps.sleep(interval);
    render = await deps.request('GET', statusPath);
    refs = extractCheckResultIds(render, params.requestedChecks);
    fetches = await fetchCheckResults(refs, deps);
  }

  return { render, refs, fetches, timedOut };
}

// --- default runner (real timers + mailgunRequest) ---

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;

export function resolveTimeoutSeconds(
  value: number | undefined,
  defaultSeconds = DEFAULT_TIMEOUT_SECONDS
): number {
  if (value === undefined) return defaultSeconds;
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_SECONDS) {
    throw new RangeError(`timeout must be an integer between 0 and ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return value;
}

// Default deadline for `preview run` create+poll; longer than the read default
// because the render starts empty right after creation.
const RUN_DEFAULT_TIMEOUT_SECONDS = 300;

function liveDeps(apiKey: string, baseUrl: string): PollDeps {
  return {
    request: (method, path, body) =>
      mailgunRequest<unknown>(buildMailgunUrl(path, undefined, baseUrl), apiKey, 'preview qa', {
        method: method as 'GET' | 'POST',
        ...(body !== undefined ? { body } : {})
      }),
    now: () => performance.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

export async function getPreviewQa(params: {
  apiKey: string;
  baseUrl: string;
  testId: string;
  timeoutSeconds?: number;
}): Promise<PreviewQaOutput> {
  const deps = liveDeps(params.apiKey, params.baseUrl);
  const timeoutMs = resolveTimeoutSeconds(params.timeoutSeconds) * 1000;
  const poll = await pollPreviewQa({ testId: params.testId, timeoutMs }, deps);
  return buildPreviewQaOutput({
    testId: params.testId,
    render: poll.render,
    refs: poll.refs,
    fetches: poll.fetches,
    timedOut: poll.timedOut
  });
}

// Create ONE preview test, then poll and summarize - the CLI's only write. The
// create is issued once and never retried (V2 is not idempotent). Failures carry
// structured recovery context for the command layer to present.
export async function runPreviewTest(params: {
  apiKey: string;
  baseUrl: string;
  create: PreviewCreateInput;
  timeoutSeconds?: number;
}): Promise<PreviewQaOutput> {
  const deps = liveDeps(params.apiKey, params.baseUrl);
  const body = buildPreviewCreateRequest(params.create);

  let created: unknown;
  try {
    created = await deps.request('POST', '/v2/preview/tests', body);
  } catch (error) {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    if (status === 429 || (typeof status === 'number' && status >= 500)) {
      throw new PreviewRunError({
        kind: 'create_uncertain',
        statusCode: status,
        referenceId: params.create.referenceId,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    // Other definitive HTTP responses preserve the established CLI error contract.
    if (typeof status === 'number' && status >= 400) throw error;
    // Ambiguous: the request may have reached Mailgun before failing.
    throw new PreviewRunError({
      kind: 'create_uncertain',
      referenceId: params.create.referenceId,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  const testId = extractCreatedTestId(created);
  if (testId === null) {
    throw new PreviewRunError({
      kind: 'create_missing_id',
      referenceId: params.create.referenceId
    });
  }

  const warnings = normalizeWarnings(created);
  const timeoutMs = resolveTimeoutSeconds(params.timeoutSeconds, RUN_DEFAULT_TIMEOUT_SECONDS) * 1000;
  const requestedChecks = new Set(params.create.contentChecks ?? CHECK_NAMES);

  let poll: PollResult;
  try {
    poll = await pollPreviewQa({ testId, timeoutMs, requestedChecks }, deps);
  } catch (error) {
    // The test WAS created; polling failure must not trigger a re-create.
    throw new PreviewRunError({
      kind: 'poll_failed',
      statusCode: (error as { statusCode?: number } | null)?.statusCode,
      testId,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  return buildPreviewQaOutput({
    testId,
    render: poll.render,
    refs: poll.refs,
    fetches: poll.fetches,
    timedOut: poll.timedOut,
    warnings,
    requestedClients: params.create.clients
  });
}

export { MAX_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS, RUN_DEFAULT_TIMEOUT_SECONDS };
