// Inspect Email Preview (v2) fixtures. List mirrors GET /v2/preview/tests (array
// of {id, date, subject, headers}); detail mirrors GET /v2/preview/tests/{id}
// (completed/processing/bounced client-id arrays + content_checking). `date` is
// epoch seconds; 1782309720 = 2026-06-24T14:02:00Z, keeping tests reproducible.

export const PREVIEW_LIST = [
  {
    id: 'preview_123',
    date: 1782309720,
    type: 'email-test',
    subject: 'June campaign',
    headers: { From: 'Marketing <news@example.com>' }
  },
  {
    id: 'preview_124',
    date: 1782302520,
    type: 'email-test',
    subject: '',
    headers: {}
  }
];

export const PREVIEW_LIST_EMPTY: unknown[] = [];

// Render/QA detail fixtures live in the shared contract file
// (fixtures/email-preview-qa-contract.ts) so the MCP and CLI QA summaries stay
// byte-identical; the list fixtures above are CLI-only.

// Capability error body for a 403 (account lacks the email preview feature).
export const PREVIEW_403 = { message: 'Email Preview is not enabled for this account' };
