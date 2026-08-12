import { UsageError } from './output.js';

export type WriteMode = 'dry-run' | 'execute';

// Reusable guard for write commands: exactly one of --dry-run (validate +
// summarize, no network) or --yes (perform the write); both or neither is a usage
// error (exit 2) before any credentials or requests. Never prompts; the intended
// pattern for future CLI writes, so keep it free of command-specific logic.
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
