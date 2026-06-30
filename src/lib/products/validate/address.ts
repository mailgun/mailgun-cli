import { UsageError } from '../../cli/output.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';
import type { DataGap } from '../../core/types.js';

// Validate v4 single-address verification. Output stays close to the API
// response, lightly renaming `reason` -> `reasons` and tolerating plan-limited
// responses. No accept/reject judgment is added: result and risk are upstream
// fields passed through, never mapped to an action.

export interface ValidateApiResponse {
  address?: string;
  result?: string;
  risk?: string;
  did_you_mean?: string;
  reason?: string[];
  engagement?: Record<string, unknown> | null;
  is_disposable_address?: boolean;
  is_role_address?: boolean;
  root_address?: string;
  last_seen?: number;
}

export interface ValidationResult {
  address: string;
  result: string | null;
  risk: string | null;
  did_you_mean: string | null;
  reasons: string[];
  engagement: Record<string, unknown>;
  is_disposable_address: boolean | null;
  is_role_address: boolean | null;
  data_gaps: DataGap[];
}

// Resolve the canonical address from a positional argument and/or --address.
// --address is canonical when both are present and equal; a mismatch is a usage
// error raised before any API call.
export function resolveAddress(positional: string | undefined, flag: string | undefined): string {
  if (flag !== undefined && positional !== undefined && flag !== positional) {
    throw new UsageError('conflicting address arguments');
  }
  const address = flag ?? positional;
  if (address === undefined || address.trim() === '') {
    throw new UsageError('an email address is required (positional or --address)');
  }
  return address;
}

export function buildValidateQuery(params: { address: string; providerLookup?: boolean }): Record<string, string | boolean> {
  const query: Record<string, string | boolean> = { address: params.address };
  if (params.providerLookup !== undefined) query.provider_lookup = params.providerLookup;
  return query;
}

export async function validateEmail(params: {
  apiKey: string;
  baseUrl: string;
  address: string;
  providerLookup?: boolean;
}): Promise<ValidationResult> {
  const url = buildMailgunUrl('/v4/address/validate', buildValidateQuery(params), params.baseUrl);
  const response = await mailgunRequest<ValidateApiResponse>(url, params.apiKey, 'address validation');
  return normalizeValidation(params.address, response);
}

export function normalizeValidation(address: string, data: ValidateApiResponse): ValidationResult {
  const dataGaps: DataGap[] = [];

  // A plan-limited or sparse response that omits the risk classification limits
  // interpretation, so surface a capability-focused gap.
  if (data.risk === undefined || data.risk === null) {
    dataGaps.push({
      code: 'validation_detail_limited',
      product: 'Validate',
      message: 'Risk classification was not returned for this address.',
      impact: 'A more complete validation can identify mailbox/provider-specific risk.'
    });
  }

  return {
    address: data.address ?? address,
    result: data.result ?? null,
    risk: data.risk ?? null,
    did_you_mean: data.did_you_mean ?? null,
    reasons: Array.isArray(data.reason) ? data.reason : [],
    engagement: data.engagement ?? {},
    is_disposable_address: data.is_disposable_address ?? null,
    is_role_address: data.is_role_address ?? null,
    data_gaps: dataGaps
  };
}
