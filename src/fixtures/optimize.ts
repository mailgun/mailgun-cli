// Optimize Inbox Placement fixtures, matched to the live v4 API:
//   - list:   { items: [ <result> ], paging, total }  (result fields underscored)
//   - detail: { result: <result> }  with delivery_stats as a provider-keyed map
//     whose `all` entry is the aggregate. Fixed June 2026 timestamps.

export const INBOX_LIST = {
  items: [
    {
      rid: '6a10cfd03874314110b9e159',
      result_id: 'result_123',
      subject: 'June campaign',
      sender: 'Marketing <news@example.com>',
      created_at: '2026-06-24T14:22:00.000Z',
      status: 'complete'
    },
    {
      rid: '7b21dfe14985425221c0f260',
      result_id: 'result_124',
      subject: 'July teaser',
      sender: 'Marketing <news@example.com>',
      created_at: '2026-06-24T16:05:00.000Z',
      status: 'processing'
    }
  ],
  paging: {},
  total: 2
};

export const INBOX_LIST_EMPTY = { items: [], paging: {}, total: 0 };

// Complete result. Aggregate comes from delivery_stats.all:
// inbox 42, spam 6, missing 1, pending 0 -> 0.857. gmail.com -> 12/15 = 0.8.
export const INBOX_RESULT_COMPLETE = {
  result: {
    result_id: 'result_123',
    status: 'complete',
    subject: 'June campaign',
    sender: 'Marketing <news@example.com>',
    spamassassin: { is_spam: false, score: 2.1, required: 5 },
    delivery_stats: {
      'gmail.com': { provider: 'gmail.com', inbox: 12, spam: 3, missing: 0, pending: 0, total: 15 },
      'outlook.com': { provider: 'outlook.com', inbox: 18, spam: 2, missing: 1, pending: 0, total: 21 },
      'yahoo.com': { provider: 'yahoo.com', inbox: 12, spam: 1, missing: 0, pending: 0, total: 13 },
      all: { provider: 'all', inbox: 42, spam: 6, missing: 1, pending: 0, total: 49 }
    }
  }
};

// Single-provider result (as returned when --provider filters upstream).
export const INBOX_RESULT_PROVIDER = {
  result: {
    result_id: 'result_123',
    status: 'complete',
    subject: 'June campaign',
    sender: 'Marketing <news@example.com>',
    spamassassin: { is_spam: false, score: 1.4, required: 5 },
    delivery_stats: {
      'gmail.com': { provider: 'gmail.com', inbox: 12, spam: 3, missing: 0, pending: 0, total: 15 },
      all: { provider: 'all', inbox: 12, spam: 3, missing: 0, pending: 0, total: 15 }
    }
  }
};

// Processing result: no placement data yet. Command still exits 0.
export const INBOX_RESULT_PROCESSING = {
  result: {
    result_id: 'result_999',
    status: 'processing',
    subject: 'August launch',
    sender: 'Marketing <news@example.com>',
    spamassassin: null,
    delivery_stats: {}
  }
};

// Capability error body for a 403 (account lacks Inbox Placement).
export const INBOX_403 = { message: 'Inbox Placement is not enabled for this account' };
