import { Command } from 'commander';
import { mergedOpts, resolveRuntime } from '../lib/core/runtime.js';
import { parseLimit, resolveRequiredArg } from '../lib/cli/input.js';
import {
  listInboxPlacementResults,
  getInboxPlacementResult,
  type InboxListOutput,
  type InboxResultOutput
} from '../lib/products/optimize/inbox-placement.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, handleCommandError, printError, printJSON } from '../lib/cli/output.js';
import { createSpinner } from '../lib/cli/spinner.js';

function printList(output: InboxListOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (output.results.length === 0) {
    if (opts.quiet !== true) process.stdout.write('No matching inbox placement results were found.\n');
    return;
  }
  for (const r of output.results) {
    process.stdout.write(`${chalk.bold(r.result_id ?? '-')}\n`);
    process.stdout.write(`  subject  ${r.subject ?? '-'}\n`);
    process.stdout.write(`  sender   ${r.sender ?? '-'}\n`);
    process.stdout.write(`  created  ${r.created_at ?? '-'}\n`);
    process.stdout.write(`  status   ${r.status ?? '-'}\n`);
  }
}

function printResult(output: InboxResultOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) process.stdout.write(`${chalk.bold(`Inbox placement - ${output.result_id}`)}\n\n`);
  const p = output.placement;
  process.stdout.write(`  status      ${output.status ?? '-'}\n`);
  process.stdout.write(`  subject     ${output.subject ?? '-'}\n`);
  process.stdout.write(`  inbox       ${p.inbox}\n`);
  process.stdout.write(`  spam        ${p.spam}\n`);
  process.stdout.write(`  missing     ${p.missing}\n`);
  process.stdout.write(`  pending     ${p.pending}\n`);
  process.stdout.write(`  inbox rate  ${p.inbox_rate === null ? 'n/a' : `${(p.inbox_rate * 100).toFixed(1)}%`}\n`);
  if (output.providers.length > 0) {
    process.stdout.write('\n  providers:\n');
    for (const pr of output.providers) {
      const rate = pr.inbox_rate === null ? 'n/a' : `${(pr.inbox_rate * 100).toFixed(1)}%`;
      process.stdout.write(`    ${(pr.provider ?? '-').padEnd(20)} inbox ${pr.inbox}  spam ${pr.spam}  missing ${pr.missing}  (${rate})\n`);
    }
  }
  for (const gap of output.data_gaps) process.stdout.write(`  ${chalk.dim(`data gap: ${gap.message}`)}\n`);
}

function registerList(parent: Command): void {
  const list = parent
    .command('list')
    .description('List recent inbox placement result IDs')
    .option('--limit <number>', 'max results to return (1-50, default 10)')
    .option('--subject <subject>', 'filter by subject')
    .option('--sender <sender>', 'filter by sender')
    .option('--provider <provider>', 'filter by provider')
    .addHelpText('after', '\nExamples:\n  mailgun inbox-placement list --limit 10 --json\n  mailgun inbox-placement list --provider gmail.com --json\n');

  addApiOptions(list);

  list.action(async (_options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const limit = parseLimit(opts.limit);
      const runtime = resolveRuntime(command, { requireApiKey: true });

      spinner.start('Fetching inbox placement results...');
      const output = await listInboxPlacementResults({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        limit,
        subject: opts.subject as string | undefined,
        sender: opts.sender as string | undefined,
        provider: opts.provider as string | undefined
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
    .description('Retrieve and summarize an inbox placement result')
    .argument('[result_id]', 'inbox placement result ID (alternative to --result)')
    .option('--result <result_id>', 'inbox placement result ID (canonical)')
    .option('--provider <provider>', 'filter to a single provider')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun inbox-placement result result_123 --json\n  mailgun inbox-placement result --result result_123 --json\n'
    );

  addApiOptions(result);

  result.action(async (positional: string | undefined, _options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const resultId = resolveRequiredArg({
        positional,
        flag: typeof opts.result === 'string' ? opts.result : undefined,
        flagName: '--result',
        missingMessage: "a result id is required (positional or --result; get one from 'mailgun inbox-placement list')"
      });
      const runtime = resolveRuntime(command, { requireApiKey: true });

      spinner.start('Fetching inbox placement result...');
      const output = await getInboxPlacementResult({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        resultId,
        provider: opts.provider as string | undefined
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

export function registerInboxPlacement(program: Command): void {
  const inbox = program.command('inbox-placement').description('Inbox placement (Optimize) commands');
  registerList(inbox);
  registerResult(inbox);

  inbox.action(() => {
    printError('missing subcommand - try `mailgun inbox-placement list` or `mailgun inbox-placement result`');
    process.exitCode = 2;
  });
}
