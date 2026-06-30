import { Command } from 'commander';
import { mergedOpts, resolveRuntime } from '../lib/core/runtime.js';
import { parseLimit, resolveRequiredArg } from '../lib/cli/input.js';
import {
  listPreviewTests,
  getPreviewResult,
  type PreviewListOutput,
  type PreviewResultOutput
} from '../lib/products/inspect/preview.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, handleCommandError, printError, printJSON } from '../lib/cli/output.js';
import { createSpinner } from '../lib/cli/spinner.js';

function printList(output: PreviewListOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (output.tests.length === 0) {
    if (opts.quiet !== true) process.stdout.write('No matching preview tests were found.\n');
    return;
  }
  for (const t of output.tests) {
    process.stdout.write(`${chalk.bold(t.test_id ?? '-')}\n`);
    process.stdout.write(`  subject  ${t.subject ?? '-'}\n`);
    process.stdout.write(`  from     ${t.from ?? '-'}\n`);
    process.stdout.write(`  created  ${t.created_at ?? '-'}\n`);
  }
}

function printResult(output: PreviewResultOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) process.stdout.write(`${chalk.bold(`Preview - ${output.test_id}`)}\n\n`);
  const s = output.summary;
  process.stdout.write(`  status      ${output.status}\n`);
  process.stdout.write(`  total       ${s.total_clients}\n`);
  process.stdout.write(`  complete    ${s.complete}\n`);
  process.stdout.write(`  processing  ${s.processing}\n`);
  process.stdout.write(`  bounced     ${s.bounced}\n`);

  const bounced = output.clients.filter((c) => c.status === 'bounced');
  if (bounced.length > 0) {
    process.stdout.write('\n  bounced clients:\n');
    for (const c of bounced) process.stdout.write(`    ${c.id}\n`);
  } else {
    const processing = output.clients.filter((c) => c.status === 'processing').slice(0, 5);
    if (processing.length > 0) {
      process.stdout.write('\n  processing clients:\n');
      for (const c of processing) process.stdout.write(`    ${c.id}\n`);
    }
  }

  for (const gap of output.data_gaps) process.stdout.write(`  ${chalk.dim(`data gap: ${gap.message}`)}\n`);
  if (opts.quiet !== true) process.stdout.write('\n  (use --json for full client list)\n');
}

function registerList(parent: Command): void {
  const list = parent
    .command('list')
    .description('List recent email preview test IDs')
    .option('--limit <number>', 'max results to return (1-50, default 10)')
    .option('--subject <subject>', 'filter by subject')
    .option('--from-date <date>', 'filter by start date')
    .option('--to-date <date>', 'filter by end date')
    .addHelpText('after', '\nExamples:\n  mailgun preview list --limit 10 --json\n  mailgun preview list --subject "June campaign" --json\n');

  addApiOptions(list);

  list.action(async (_options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const limit = parseLimit(opts.limit);
      const runtime = resolveRuntime(command, { requireApiKey: true });

      spinner.start('Fetching preview tests...');
      const output = await listPreviewTests({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        limit,
        subject: opts.subject as string | undefined,
        fromDate: opts.fromDate as string | undefined,
        toDate: opts.toDate as string | undefined
      });
      spinner.stop();

      if (runtime.json) printJSON(output);
      else printList(output, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });
}

function registerResult(parent: Command): void {
  const result = parent
    .command('result')
    .description('Retrieve and summarize an email preview result')
    .argument('[test_id]', 'email preview test ID (alternative to --test-id)')
    .option('--test-id <test_id>', 'email preview test ID (canonical)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun preview result preview_123 --json\n  mailgun preview result --test-id preview_123 --json\n'
    );

  addApiOptions(result);

  result.action(async (positional: string | undefined, _options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const testId = resolveRequiredArg({
        positional,
        flag: typeof opts.testId === 'string' ? opts.testId : undefined,
        flagName: '--test-id',
        missingMessage: "a test id is required (positional or --test-id; get one from 'mailgun preview list')"
      });
      const runtime = resolveRuntime(command, { requireApiKey: true });

      spinner.start('Fetching preview result...');
      const output = await getPreviewResult({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        testId
      });
      spinner.stop();

      if (runtime.json) printJSON(output);
      else printResult(output, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });
}

export function registerPreview(program: Command): void {
  const preview = program.command('preview').description('Email preview (Inspect) commands');
  registerList(preview);
  registerResult(preview);

  preview.action(() => {
    printError('missing subcommand - try `mailgun preview list` or `mailgun preview result`');
    process.exitCode = 2;
  });
}
