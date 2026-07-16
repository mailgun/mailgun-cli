import { UsageError } from '../../cli/output.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';
import type { DataGap } from '../../core/types.js';
import {
  checkResultPath,
  detailStatus,
  extractCheckResultIds,
  type CheckName
} from './preview-checks.js';
import {
  asArray,
  asRecord,
  numberOrNull,
  stringArray,
  stringOrNull
} from './preview-values.js';

export type PreviewIssueCheck = Exclude<CheckName, 'code_analysis'>;
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
  check: PreviewIssueCheck;
  result_id: string;
  status: 'complete' | 'processing';
  totals: { confirmed: number; needs_review: number };
  issues: PreviewIssue[];
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
            standards: stringArray(rule.standards),
            line: numberOrNull(instance.lineNumber ?? instance.line),
            column: numberOrNull(instance.column),
            target: stringArray(instance.target),
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
        standards: stringArray(failure.standards),
        line: numberOrNull(item.line),
        column: numberOrNull(item.column),
        target: stringArray(failure.target),
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
  check: PreviewIssueCheck;
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
