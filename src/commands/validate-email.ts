import { Command } from 'commander';
import { mergedOpts, resolveRuntime } from '../lib/runtime.js';
import { buildMailgunUrl, mailgunRequest } from '../lib/mailgun.js';
import {
  buildValidateQuery,
  normalizeValidation,
  resolveAddress,
  type ValidateApiResponse,
  type ValidationResult
} from '../lib/validate.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, handleCommandError, printJSON, UsageError } from '../lib/output.js';
import { createSpinner } from '../lib/spinner.js';

// --provider-lookup requires an explicit true/false; anything else exits 2.
export function parseProviderLookup(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new UsageError('--provider-lookup requires an explicit true or false');
}

function printHuman(result: ValidationResult, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) process.stdout.write(`${chalk.bold(`Validation - ${result.address}`)}\n\n`);
  const rows: Array<[string, string]> = [
    ['Result', result.result ?? '-'],
    ['Risk', result.risk ?? '-'],
    ['Did you mean', result.did_you_mean ?? '-'],
    ['Disposable', result.is_disposable_address === null ? '-' : String(result.is_disposable_address)],
    ['Role address', result.is_role_address === null ? '-' : String(result.is_role_address)]
  ];
  for (const [label, value] of rows) process.stdout.write(`  ${label.padEnd(14)} ${value}\n`);
  if (result.reasons.length > 0) process.stdout.write(`  ${'Reasons'.padEnd(14)} ${result.reasons.join(', ')}\n`);
  for (const gap of result.data_gaps) process.stdout.write(`  ${chalk.dim(`data gap: ${gap.message}`)}\n`);
}

export function registerValidateEmail(program: Command): void {
  const command = program
    .command('validate-email')
    .description('Validate a single email address')
    .argument('[address]', 'email address to validate (alternative to --address)')
    .option('--address <email>', 'email address to validate (canonical)')
    .option('--provider-lookup <boolean>', 'enable provider lookup (true or false)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun validate-email --address user@example.com --json\n  mailgun validate-email user@example.com --json\n'
    );

  addApiOptions(command);

  command.action(async (positional: string | undefined, _options, cmd: Command) => {
    const spinner = createSpinner(mergedOpts(cmd));
    try {
      const opts = mergedOpts(cmd);
      const address = resolveAddress(positional, opts.address as string | undefined);
      const providerLookup = parseProviderLookup(opts.providerLookup);
      const runtime = resolveRuntime(cmd, { requireApiKey: true });

      spinner.start('Validating address...');
      const url = buildMailgunUrl('/v4/address/validate', buildValidateQuery({ address, providerLookup }), runtime.baseUrl);
      const response = await mailgunRequest<ValidateApiResponse>(url, runtime.apiKey!, 'address validation', {
        product: 'Validate'
      });
      spinner.stop();

      const result = normalizeValidation(address, response);
      if (runtime.json) printJSON(result);
      else printHuman(result, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });
}
