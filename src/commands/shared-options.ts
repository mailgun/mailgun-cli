import type { Command } from 'commander';

// Add the common P0 API flags directly to an API subcommand so post-subcommand
// flags parse correctly. These mirror the parent program globals so both forms
// work: `mailgun <cmd> --api-key X` and `mailgun --api-key X <cmd>`.
//
// Pass `{ domain: true }` only for commands where a Mailgun sending domain
// affects behavior (e.g. `metrics summary`, `events`).
export interface ApiOptionConfig {
  domain?: boolean;
}

export function addApiOptions(command: Command, config: ApiOptionConfig = {}): Command {
  command
    .option('--json', 'output as machine-readable JSON')
    .option('--quiet', 'suppress non-essential output')
    .option('--api-key <key>', 'override MAILGUN_API_KEY env var; prefer env vars for shared shells')
    .option('--region <us|eu>', 'Mailgun API region (default us; or set MAILGUN_API_REGION)');

  if (config.domain) {
    command.option('--domain <domain>', 'override MAILGUN_DOMAIN env var');
  }

  return command;
}
