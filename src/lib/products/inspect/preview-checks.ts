import { asArray, asRecord, stringOrNull } from './preview-values.js';

export type CheckName = 'link_validation' | 'image_validation' | 'accessibility' | 'code_analysis';

export const CHECK_NAMES: readonly CheckName[] = [
  'link_validation',
  'image_validation',
  'accessibility',
  'code_analysis'
];

export interface CheckReference {
  requested: boolean;
  hasErrors: boolean;
  resultId: string | null;
}

export function extractCheckResultIds(
  render: unknown,
  requestedChecks?: ReadonlySet<CheckName>
): Record<CheckName, CheckReference> {
  const contentChecking = asRecord(asRecord(render).content_checking);
  const result = {} as Record<CheckName, CheckReference>;
  for (const name of CHECK_NAMES) {
    const raw = contentChecking[name];
    if (raw === null) {
      result[name] = { requested: false, hasErrors: false, resultId: null };
      continue;
    }
    if (raw === undefined) {
      result[name] = {
        requested: requestedChecks ? requestedChecks.has(name) : true,
        hasErrors: false,
        resultId: null
      };
      continue;
    }
    const node = asRecord(raw);
    result[name] = {
      requested: true,
      hasErrors: asArray(node.errors).length > 0,
      resultId: stringOrNull(asRecord(node.items).id)
    };
  }
  return result;
}

export function checkResultPath(name: CheckName, resultId: string): string {
  const id = encodeURIComponent(resultId);
  switch (name) {
    case 'link_validation':
      return `/v1/inspect/links/${id}`;
    case 'image_validation':
      return `/v1/inspect/images/${id}`;
    case 'accessibility':
      return `/v1/inspect/accessibility/${id}`;
    case 'code_analysis':
      return `/v1/inspect/analyze/${id}`;
  }
}

// Completion signal from the detail payload's meta.status (case-insensitive; missing = complete).
export function detailStatus(payload: unknown): 'complete' | 'processing' {
  const value = asRecord(asRecord(payload).meta).status;
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    status.startsWith('process') ||
    status.startsWith('pending') ||
    status.startsWith('queu') ||
    status.startsWith('run')
  ) {
    return 'processing';
  }
  return 'complete';
}
