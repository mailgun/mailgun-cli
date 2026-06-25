import type { ProductLabel } from '../lib/types.js';

// Curated registry of durable PRODUCTION CLI commands. This represents the
// supported CLI surface, not the set of Mailgun API endpoints. `agent-context`
// is serialized directly from this registry, so adding a production command
// means adding it here. Retired workshop demo commands (health, investigate)
// are intentionally absent.

export type CommandCategory = 'introspection' | 'utility' | 'parity';

export interface RegistryCommand {
  command: string;
  category: CommandCategory;
  mode: 'read';
  description: string;
  product?: ProductLabel;
  mcpTool?: string;
  flags: string[];
  outputFields: string[];
  outputFormat?: string;
  examples: string[];
}

export const COMMAND_REGISTRY: RegistryCommand[] = [
  {
    command: 'agent-context',
    category: 'introspection',
    mode: 'read',
    description: 'Return machine-readable CLI schema for agent introspection',
    flags: [],
    outputFields: ['schema_version', 'cli_version', 'name', 'description', 'auth', 'commands'],
    examples: ['mailgun agent-context | jq .commands']
  },
  {
    command: 'events',
    category: 'utility',
    mode: 'read',
    description: 'Stream live delivery events',
    flags: ['--tail', '--filter', '--interval', '--limit', '--domain', '--region', '--json', '--quiet'],
    outputFormat: 'ndjson',
    outputFields: ['timestamp', 'event', 'recipient', 'domain', 'reason', 'code', 'tags'],
    examples: ['mailgun events --domain acme.com --tail', 'mailgun events --domain acme.com --json']
  },
  {
    command: 'metrics summary',
    category: 'parity',
    mode: 'read',
    description: 'Summarize sending metrics (counts and computed rates) for a domain and window',
    product: 'Analytics',
    mcpTool: 'get_metrics_summary',
    flags: ['--domain', '--window', '--duration', '--start', '--end', '--timezone', '--region', '--json', '--quiet'],
    outputFields: ['domain', 'metrics_raw', 'rates', 'data_gaps', 'window'],
    examples: [
      'mailgun metrics summary --domain acme.com --json',
      'mailgun metrics summary --domain acme.com --duration 24h --json'
    ]
  },
  {
    command: 'validate-email',
    category: 'parity',
    mode: 'read',
    description: 'Validate a single email address',
    product: 'Validate',
    mcpTool: 'validate_email',
    flags: ['--address', '--provider-lookup', '--region', '--json', '--quiet'],
    outputFields: [
      'address',
      'result',
      'risk',
      'did_you_mean',
      'reasons',
      'engagement',
      'is_disposable_address',
      'is_role_address',
      'data_gaps'
    ],
    examples: [
      'mailgun validate-email --address user@example.com --json',
      'mailgun validate-email user@example.com --json'
    ]
  },
  {
    command: 'inbox-placement list',
    category: 'parity',
    mode: 'read',
    description: 'List recent inbox placement result IDs',
    product: 'Optimize',
    flags: ['--limit', '--subject', '--sender', '--provider', '--region', '--json', '--quiet'],
    outputFields: ['results', 'data_gaps'],
    examples: [
      'mailgun inbox-placement list --limit 10 --json',
      'mailgun inbox-placement list --provider gmail.com --json'
    ]
  },
  {
    command: 'inbox-placement result',
    category: 'parity',
    mode: 'read',
    description: 'Retrieve and summarize an inbox placement result',
    product: 'Optimize',
    mcpTool: 'get_inbox_placement_result',
    flags: ['--result', '--provider', '--region', '--json', '--quiet'],
    outputFields: ['result_id', 'status', 'subject', 'sender', 'placement', 'providers', 'spamassassin', 'data_gaps'],
    examples: [
      'mailgun inbox-placement result --result result_123 --json',
      'mailgun inbox-placement result --result result_123 --provider gmail.com --json'
    ]
  },
  {
    command: 'preview list',
    category: 'parity',
    mode: 'read',
    description: 'List recent email preview test IDs',
    product: 'Inspect',
    flags: ['--limit', '--subject', '--from-date', '--to-date', '--region', '--json', '--quiet'],
    outputFields: ['tests', 'data_gaps'],
    examples: [
      'mailgun preview list --limit 10 --json',
      'mailgun preview list --subject "June campaign" --json'
    ]
  },
  {
    command: 'preview result',
    category: 'parity',
    mode: 'read',
    description: 'Retrieve and summarize an email preview result',
    product: 'Inspect',
    mcpTool: 'get_preview_result',
    flags: ['--test-id', '--region', '--json', '--quiet'],
    outputFields: ['test_id', 'status', 'summary', 'clients', 'content_checking', 'data_gaps'],
    examples: ['mailgun preview result --test-id preview_123 --json']
  }
];
