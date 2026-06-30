#!/usr/bin/env node
import { Command, Option } from 'commander';
import { registerAgentContext } from './commands/agent-context.js';
import { registerEvents } from './commands/events.js';
import { registerMetrics } from './commands/metrics.js';
import { registerValidateEmail } from './commands/validate-email.js';
import { registerInboxPlacement } from './commands/inbox-placement.js';
import { registerPreview } from './commands/preview.js';
import { CLI_VERSION } from './lib/core/version.js';

const program = new Command();

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

program
  .name('mailgun')
  .description('Mailgun CLI - agent-first developer surface')
  .version(CLI_VERSION)
  // Parent-level mirrors of the shared API flags so the pre-subcommand form
  // works too: `mailgun --domain acme.com metrics summary --json`.
  .option('--json', 'output as machine-readable JSON')
  .option('--quiet', 'suppress non-essential output')
  .option('--api-key <key>', 'override MAILGUN_API_KEY env var; prefer env vars for shared shells')
  .option('--region <us|eu>', 'Mailgun API region (default us; or set MAILGUN_API_REGION)')
  // --domain is command-scoped (only commands that use a sending domain expose it
  // in their own help). It is mirrored at the parent level solely so the
  // pre-subcommand form works (`mailgun --domain acme.com metrics summary`), so
  // hide it from the global help to avoid advertising it where it has no effect.
  .addOption(new Option('--domain <domain>', 'override MAILGUN_DOMAIN env var').hideHelp());

registerAgentContext(program);
registerEvents(program);
registerMetrics(program);
registerValidateEmail(program);
registerInboxPlacement(program);
registerPreview(program);

await program.parseAsync(process.argv);
