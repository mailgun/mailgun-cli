import type { ValidateApiResponse } from '../lib/products/validate/address.js';

// Fixtures mirror the raw `GET /v4/address/validate` response. The Validate
// response varies by plan, so these cover full, plan-limited, and risky shapes.

// Scenario: deliverable address with a domain typo correction.
export const VALIDATE_DELIVERABLE_TYPO: ValidateApiResponse = {
  address: 'john_snow@yaho.com',
  result: 'deliverable',
  risk: 'low',
  did_you_mean: 'john_snow@yahoo.com',
  reason: [],
  engagement: {},
  is_disposable_address: false,
  is_role_address: false,
  root_address: 'john_snow@yaho.com'
};

// Scenario: a plan-limited / sparse response that omits risk and engagement.
// The normalizer tolerates the missing fields and emits a data gap.
export const VALIDATE_MINIMAL: ValidateApiResponse = {
  address: 'someone@example.com',
  result: 'deliverable'
};

// Scenario: an undeliverable, high-risk address. The command still exits 0.
export const VALIDATE_UNDELIVERABLE: ValidateApiResponse = {
  address: 'noreply@invalid-domain.test',
  result: 'undeliverable',
  risk: 'high',
  reason: ['mailbox_does_not_exist'],
  engagement: {},
  is_disposable_address: false,
  is_role_address: true
};
