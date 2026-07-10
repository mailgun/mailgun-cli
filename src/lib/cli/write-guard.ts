import { UsageError } from './output.js';

export type WriteMode = 'dry-run' | 'execute';

// Reusable guard for write commands. It forces the caller to make intent
// explicit: exactly one of --dry-run (validate + summarize, never touches the
// network) or --yes (perform the write). Passing both or neither is a usage
// error (exit 2) raised before any credentials are read or requests are made.
//
// This guard NEVER prompts. It is the intended pattern for every future CLI
// write command, so keep it free of command-specific logic.
export function resolveWriteMode(opts: { dryRun?: boolean; yes?: boolean }): WriteMode {
  const dryRun = opts.dryRun === true;
  const yes = opts.yes === true;

  if (dryRun && yes) {
    throw new UsageError('--dry-run and --yes cannot be combined; pass exactly one');
  }
  if (!dryRun && !yes) {
    throw new UsageError(
      'this command performs a write - pass --dry-run to preview the request or --yes to execute it'
    );
  }
  return dryRun ? 'dry-run' : 'execute';
}
