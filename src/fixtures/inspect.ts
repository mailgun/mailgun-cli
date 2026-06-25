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

// Complete result: all clients rendered, link + image validation available.
export const PREVIEW_RESULT_COMPLETE = {
  subject: 'June campaign',
  date: 1782309720,
  completed: ['gmail_chrome', 'outlook_win', 'apple_mail'],
  processing: [],
  bounced: [],
  content_checking: {
    link_validation: { items: { links: { self: '/v1/inspect/links/abc123' } } },
    image_validation: { items: { links: { self: '/v1/inspect/images/def456' } } },
    accessibility: { items: { links: {} } },
    code_analysis: { items: { links: {} } }
  }
};

// Partial result: a client bounced and none are still processing -> status partial.
export const PREVIEW_RESULT_PARTIAL = {
  subject: 'June campaign',
  date: 1782309720,
  completed: ['gmail_chrome', 'outlook_win'],
  processing: [],
  bounced: ['lotus_notes'],
  content_checking: {
    link_validation: { items: { links: {} } },
    image_validation: { items: { links: {} } },
    accessibility: { items: { links: {} } },
    code_analysis: { items: { links: {} } }
  }
};

// Processing result: at least one client still processing -> status processing.
export const PREVIEW_RESULT_PROCESSING = {
  subject: 'June campaign',
  date: 1782309720,
  completed: ['gmail_chrome'],
  processing: ['outlook_win', 'apple_mail'],
  bounced: [],
  content_checking: {}
};

// Capability error body for a 403 (account lacks Email Preview/Inspect).
export const PREVIEW_403 = { message: 'Email Preview is not enabled for this account' };
