import { existsSync, writeFileSync } from 'node:fs';
import fetch from 'node-fetch';
import { CliError, UsageError } from '../../cli/output.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';
import type { DataGap } from '../../core/types.js';
import {
  checkResultPath,
  detailStatus,
  extractCheckResultIds,
  type CheckName
} from './preview-qa.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

export type PreviewIssueKind = 'failure' | 'needs_review';

export interface PreviewIssue {
  kind: PreviewIssueKind;
  rule: string | null;
  impact: string | null;
  description: string | null;
  standards: string[];
  line: number | null;
  column: number | null;
  target: string[];
  snippet: string | null;
  url: string | null;
}

export interface PreviewIssuesOutput {
  test_id: string;
  check: CheckName;
  result_id: string;
  status: 'complete' | 'processing';
  totals: { confirmed: number; needs_review: number };
  issues: PreviewIssue[];
  data_gaps: DataGap[];
}

interface RenderVariant {
  name: string;
  url: string;
}

export interface PreviewRenderOutput {
  test_id: string;
  client_id: string;
  display_name: string | null;
  client: string | null;
  os: string | null;
  browser: string | null;
  category: string | null;
  status: string | null;
  available_variants: string[];
  selected_variant: string | null;
  output_path: string | null;
  bytes: number | null;
  data_gaps: DataGap[];
}

function accessibilityIssues(payload: unknown): PreviewIssue[] {
  const issues: PreviewIssue[] = [];
  for (const group of asArray(asRecord(payload).items)) {
    const groupRecord = asRecord(group);
    for (const [kind, rawRules] of [
      ['failure', groupRecord.failures],
      ['needs_review', groupRecord.needs_review]
    ] as const) {
      for (const rawRule of asArray(rawRules)) {
        const rule = asRecord(rawRule);
        const instances = asArray(rule.instances);
        for (const rawInstance of instances.length > 0 ? instances : [{}]) {
          const instance = asRecord(rawInstance);
          issues.push({
            kind,
            rule: stringOrNull(rule.rule),
            impact: stringOrNull(rule.impact),
            description: stringOrNull(rule.description),
            standards: strings(rule.standards),
            line: numberOrNull(instance.lineNumber ?? instance.line),
            column: numberOrNull(instance.column),
            target: strings(instance.target),
            snippet: stringOrNull(instance.snippet),
            url: null
          });
        }
      }
    }
  }
  return issues;
}

function validationIssues(payload: unknown, collection: 'results' | 'images'): PreviewIssue[] {
  const issues: PreviewIssue[] = [];
  for (const rawItem of asArray(asRecord(asRecord(payload).items)[collection])) {
    const item = asRecord(rawItem);
    for (const rawFailure of asArray(item.failures)) {
      const failure = asRecord(rawFailure);
      issues.push({
        kind: 'failure',
        rule: stringOrNull(failure.rule),
        impact: stringOrNull(failure.impact),
        description: stringOrNull(failure.description),
        standards: strings(failure.standards),
        line: numberOrNull(item.line),
        column: numberOrNull(item.column),
        target: strings(failure.target),
        snippet: stringOrNull(failure.snippet),
        url: stringOrNull(item.url)
      });
    }
  }
  return issues;
}

export async function getPreviewIssues(params: {
  apiKey: string;
  baseUrl: string;
  testId: string;
  check: CheckName;
}): Promise<PreviewIssuesOutput> {
  const statusUrl = buildMailgunUrl(
    `/v2/preview/tests/${encodeURIComponent(params.testId)}`,
    undefined,
    params.baseUrl
  );
  const render = await mailgunRequest<unknown>(statusUrl, params.apiKey, 'preview test status');
  const ref = extractCheckResultIds(render)[params.check];
  if (!ref.requested) {
    throw new UsageError(`the ${params.check} check was not requested for preview test ${params.testId}`);
  }
  if (ref.resultId === null) {
    throw new UsageError(
      `the ${params.check} result is not available yet; resume with 'mailgun preview result ${params.testId}'`
    );
  }

  const detailUrl = buildMailgunUrl(checkResultPath(params.check, ref.resultId), undefined, params.baseUrl);
  const payload = await mailgunRequest<unknown>(detailUrl, params.apiKey, `${params.check} result`);
  const status = detailStatus(payload);
  let issues: PreviewIssue[] = [];
  if (status === 'complete') {
    switch (params.check) {
      case 'accessibility':
        issues = accessibilityIssues(payload);
        break;
      case 'link_validation':
        issues = validationIssues(payload, 'results');
        break;
      case 'image_validation':
        issues = validationIssues(payload, 'images');
        break;
      case 'code_analysis':
        throw new UsageError('preview issues does not yet support --check code_analysis');
    }
  }
  return {
    test_id: params.testId,
    check: params.check,
    result_id: ref.resultId,
    status,
    totals: {
      confirmed: issues.filter((issue) => issue.kind === 'failure').length,
      needs_review: issues.filter((issue) => issue.kind === 'needs_review').length
    },
    issues,
    data_gaps: []
  };
}

function renderVariants(record: Record<string, unknown>): RenderVariant[] {
  const variants: RenderVariant[] = [];
  for (const [name, value] of Object.entries(asRecord(record.screenshots))) {
    if (typeof value === 'string' && value.length > 0) variants.push({ name, url: value });
  }
  for (const name of ['thumbnail', 'full_thumbnail'] as const) {
    const value = record[name];
    if (typeof value === 'string' && value.length > 0) variants.push({ name, url: value });
  }
  return variants.sort((a, b) => a.name.localeCompare(b.name));
}

function defaultRenderVariant(variants: RenderVariant[]): RenderVariant | null {
  return variants.find((variant) => variant.name === 'default')
    ?? variants.find((variant) => variant.name !== 'full_thumbnail' && variant.name !== 'thumbnail')
    ?? variants.find((variant) => variant.name === 'full_thumbnail')
    ?? variants.find((variant) => variant.name === 'thumbnail')
    ?? null;
}

const MAX_RENDER_BYTES = 25 * 1024 * 1024;
const RENDER_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_RENDER_RETRY_DELAY_MS = 2_000;

function renderRetryDelayMs(retryAfter: string | null, retryCount: number): number {
  const fallback = Math.min(250 * (2 ** retryCount), MAX_RENDER_RETRY_DELAY_MS);
  if (retryAfter === null) return fallback;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1_000, fallback), RENDER_DOWNLOAD_TIMEOUT_MS);
  }
  const retryAt = Date.parse(retryAfter);
  if (!Number.isFinite(retryAt)) return fallback;
  return Math.min(Math.max(retryAt - Date.now(), fallback), RENDER_DOWNLOAD_TIMEOUT_MS);
}

async function waitForRenderRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('render retry aborted');
  await new Promise<void>((resolve, reject) => {
    const retryTimer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(retryTimer);
      reject(new Error('render retry aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function downloadRender(urlValue: string, outputPath: string): Promise<number> {
  if (existsSync(outputPath)) throw new UsageError(`--output path already exists: ${outputPath}`);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new CliError('Mailgun returned an invalid preview render URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('Mailgun returned an unsupported preview render URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_DOWNLOAD_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    let response;
    let retryCount = 0;
    while (true) {
      response = await fetch(url, { signal: controller.signal });
      if (response.status !== 425) break;
      const body = response.body as (NodeJS.ReadableStream & { destroy?: () => void }) | null;
      body?.destroy?.();
      const delayMs = renderRetryDelayMs(response.headers.get('retry-after'), retryCount);
      retryCount += 1;
      await waitForRenderRetry(delayMs, controller.signal);
    }
    if (!response.ok) throw new CliError(`Preview render download returned ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new CliError('Preview render download did not return an image');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RENDER_BYTES) {
      throw new CliError('Preview render image exceeds the 25 MiB download limit');
    }
    if (!response.body) throw new CliError('Preview render download returned an empty body');
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_RENDER_BYTES) {
        controller.abort();
        throw new CliError('Preview render image exceeds the 25 MiB download limit');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      controller.signal.aborted
        ? `Preview render download timed out after ${RENDER_DOWNLOAD_TIMEOUT_MS}ms`
        : 'Failed to download preview render image'
    );
  } finally {
    clearTimeout(timer);
  }
  writeFileSync(outputPath, Buffer.concat(chunks, totalBytes), { flag: 'wx' });
  return totalBytes;
}

export async function getPreviewRender(params: {
  apiKey: string;
  baseUrl: string;
  testId: string;
  clientId: string;
  variant?: string;
  outputPath?: string;
}): Promise<PreviewRenderOutput> {
  if (params.variant !== undefined && params.outputPath === undefined) {
    throw new UsageError('--variant requires --output');
  }
  const url = buildMailgunUrl(
    `/v2/preview/tests/${encodeURIComponent(params.testId)}/results/${encodeURIComponent(params.clientId)}`,
    undefined,
    params.baseUrl
  );
  const response = await mailgunRequest<unknown>(url, params.apiKey, 'preview client result');
  const responseRecord = asRecord(response);
  const selectedRecord = asRecord(responseRecord[params.clientId]);
  const record = Object.keys(selectedRecord).length > 0
    ? selectedRecord
    : asRecord(Object.values(responseRecord)[0]);
  if (Object.keys(record).length === 0) {
    throw new CliError(`Mailgun returned no render for client ${params.clientId}`);
  }
  const variants = renderVariants(record);
  const selected = params.variant !== undefined
    ? variants.find((variant) => variant.name === params.variant) ?? null
    : params.outputPath !== undefined
      ? defaultRenderVariant(variants)
      : null;
  if (params.variant !== undefined && selected === null) {
    throw new UsageError(
      `render variant '${params.variant}' is unavailable; choose one of: ${variants.map((variant) => variant.name).join(', ') || 'none'}`
    );
  }
  if (params.outputPath !== undefined && selected === null) {
    throw new UsageError(`Mailgun returned no screenshot assets for client ${params.clientId}`);
  }
  const bytes = selected && params.outputPath
    ? await downloadRender(selected.url, params.outputPath)
    : null;
  return {
    test_id: params.testId,
    client_id: stringOrNull(record.id) ?? params.clientId,
    display_name: stringOrNull(record.display_name),
    client: stringOrNull(record.client),
    os: stringOrNull(record.os),
    browser: stringOrNull(record.browser),
    category: stringOrNull(record.category),
    status: stringOrNull(record.status),
    available_variants: variants.map((variant) => variant.name),
    selected_variant: selected?.name ?? null,
    output_path: params.outputPath ?? null,
    bytes,
    data_gaps: []
  };
}
