import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { mergedOpts, resolveRuntime } from '../lib/core/runtime.js';
import {
  parseLimit,
  parseMaxSeedsPerProvider,
  parseProvidersList,
  parseTimeoutSeconds,
  resolveRequiredArg
} from '../lib/cli/input.js';
import {
  listInboxPlacementResults,
  getInboxPlacementResult,
  runInboxPlacementTest,
  InboxRunError,
  type InboxCreateInput,
  type InboxContentSource,
  type InboxListOutput,
  type InboxResultOutput,
  type InboxRunOutput
} from '../lib/products/optimize/inbox-placement.js';
import { addApiOptions } from './shared-options.js';
import { CliError, handleCommandError, printError, printJSON, UsageError, chalkFor } from '../lib/cli/output.js';
import { resolveWriteMode } from '../lib/cli/write-guard.js';
import { createSpinner } from '../lib/cli/spinner.js';
import type { CommandDescriptor } from './descriptor.js';

const MAX_HTML_BYTES = 5 * 1024 * 1024;

interface HtmlSource {
  path: string;
  html: string;
  bytes: number;
  sha256: string;
}

// Read the HTML payload from a file (file-only; never stdin, never inline). All
// failures are usage errors raised before any network call so a bad artifact
// can never create a placement test.
function readHtmlSource(pathValue: unknown): HtmlSource {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') {
    throw new UsageError('--html <file> is required and must be a path to an HTML file');
  }
  const path = pathValue.trim();
  let html: string;
  try {
    html = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`could not read --html file '${path}': ${reason}`);
  }
  if (html.trim() === '') {
    throw new UsageError(`--html file '${path}' is empty`);
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    throw new UsageError(
      `--html file '${path}' is ${bytes} UTF-8 bytes, over the ${MAX_HTML_BYTES}-byte (5 MiB) CLI limit`
    );
  }
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  return { path, html, bytes, sha256 };
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveContentSource(opts: Record<string, unknown>): {
  content: InboxContentSource;
  htmlSource?: HtmlSource;
} {
  const htmlPath = typeof opts.html === 'string' ? opts.html.trim() : '';
  const templateName = optionalTrimmedString(opts.templateName);
  const accountTemplateName = optionalTrimmedString(opts.accountTemplateName);
  const selected = [
    htmlPath !== '' ? 'html' : null,
    templateName ? 'template_name' : null,
    accountTemplateName ? 'account_template_name' : null
  ].filter(Boolean);

  if (selected.length === 0) {
    throw new UsageError(
      'exactly one content source is required: --html, --template-name, or --account-template-name'
    );
  }
  if (selected.length > 1) {
    throw new UsageError(
      'pass exactly one content source among --html, --template-name, and --account-template-name'
    );
  }

  if (htmlPath !== '') {
    const htmlSource = readHtmlSource(htmlPath);
    return { content: { kind: 'html', html: htmlSource.html }, htmlSource };
  }
  if (templateName) {
    return { content: { kind: 'template_name', templateName } };
  }
  return { content: { kind: 'account_template_name', accountTemplateName: accountTemplateName! } };
}

export const INBOX_PLACEMENT_DESCRIPTORS: CommandDescriptor[] = [
  {
    command: 'inbox-placement list',
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
    command: 'inbox-placement run',
    mode: 'write',
    description: 'Create and summarize an inbox placement test (sends to seed addresses, consumes quota)',
    product: 'Optimize',
    flags: [
      '--from',
      '--subject',
      '--html',
      '--template-name',
      '--account-template-name',
      '--seed-list',
      '--providers',
      '--sending-ip',
      '--sending-ip-pool-id',
      '--max-seeds-per-provider',
      '--timeout',
      '--dry-run',
      '--yes',
      '--region',
      '--json',
      '--quiet'
    ],
    outputFields: [
      'result_id',
      'status',
      'timed_out',
      'mailing_list',
      'subject',
      'sender',
      'placement',
      'providers',
      'spamassassin',
      'data_gaps'
    ],
    examples: [
      'mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --dry-run',
      'mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --yes --json',
      'mailgun inbox-placement run --from news@example.com --subject "Promo" --template-name welcome --providers gmail.com --yes'
    ]
  }
];

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

function printResult(
  output: InboxResultOutput | InboxRunOutput,
  opts: { json?: boolean; quiet?: boolean }
): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) process.stdout.write(`${chalk.bold(`Inbox placement - ${output.result_id}`)}\n\n`);
  const timedOut = 'timed_out' in output && output.timed_out === true;
  const p = output.placement;
  process.stdout.write(`  status      ${output.status ?? '-'}${timedOut ? ' (timed out)' : ''}\n`);
  process.stdout.write(`  subject     ${output.subject ?? '-'}\n`);
  if ('mailing_list' in output && output.mailing_list) {
    process.stdout.write(`  mailing     ${output.mailing_list}\n`);
  }
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

interface DryRunSummary {
  dry_run: true;
  action: 'run_inbox_placement_test';
  will_consume_quota: true;
  will_send_to_seeds: true;
  from: string;
  subject: string;
  content:
    | { type: 'html'; path: string; bytes: number; sha256: string }
    | { type: 'template_name'; template_name: string }
    | { type: 'account_template_name'; account_template_name: string };
  timeout_seconds: number;
  seed_list?: string;
  providers?: string[];
  uses_all_providers?: true;
  sending_ip?: string;
  sending_ip_pool_id?: string;
  max_seeds_per_provider?: number;
}

function buildDryRunSummary(
  create: InboxCreateInput,
  htmlSource: HtmlSource | undefined,
  timeoutSeconds: number
): DryRunSummary {
  let content: DryRunSummary['content'];
  if (create.content.kind === 'html') {
    if (!htmlSource) throw new UsageError('internal error: html source metadata missing for dry-run');
    content = {
      type: 'html',
      path: htmlSource.path,
      bytes: htmlSource.bytes,
      sha256: htmlSource.sha256
    };
  } else if (create.content.kind === 'template_name') {
    content = { type: 'template_name', template_name: create.content.templateName };
  } else {
    content = {
      type: 'account_template_name',
      account_template_name: create.content.accountTemplateName
    };
  }

  const summary: DryRunSummary = {
    dry_run: true,
    action: 'run_inbox_placement_test',
    will_consume_quota: true,
    will_send_to_seeds: true,
    from: create.from,
    subject: create.subject,
    content,
    timeout_seconds: timeoutSeconds
  };
  if (create.seedList) summary.seed_list = create.seedList;
  if (create.providers && create.providers.length > 0) summary.providers = [...create.providers];
  else summary.uses_all_providers = true;
  if (create.sendingIp) summary.sending_ip = create.sendingIp;
  if (create.sendingIpPoolId) summary.sending_ip_pool_id = create.sendingIpPoolId;
  if (create.maxSeedsPerProvider !== undefined) summary.max_seeds_per_provider = create.maxSeedsPerProvider;
  return summary;
}

function printDryRun(summary: DryRunSummary, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  process.stdout.write(`${chalk.bold('inbox-placement run (dry run)')}\n`);
  process.stdout.write(
    `  ${chalk.dim('executing this request will create a remote Optimize placement test, send to seed addresses, and consume quota')}\n\n`
  );
  process.stdout.write(`  from            ${summary.from}\n`);
  process.stdout.write(`  subject         ${summary.subject}\n`);
  if (summary.content.type === 'html') {
    process.stdout.write(`  html path       ${summary.content.path}\n`);
    process.stdout.write(`  html bytes      ${summary.content.bytes}\n`);
    process.stdout.write(`  html sha256     ${summary.content.sha256}\n`);
  } else if (summary.content.type === 'template_name') {
    process.stdout.write(`  template        ${summary.content.template_name}\n`);
  } else {
    process.stdout.write(`  account tmpl    ${summary.content.account_template_name}\n`);
  }
  process.stdout.write(
    `  providers       ${summary.providers ? summary.providers.join(', ') : 'all Mailgun providers'}\n`
  );
  if (summary.seed_list) process.stdout.write(`  seed list       ${summary.seed_list}\n`);
  if (summary.sending_ip) process.stdout.write(`  sending ip      ${summary.sending_ip}\n`);
  if (summary.sending_ip_pool_id) process.stdout.write(`  ip pool         ${summary.sending_ip_pool_id}\n`);
  if (summary.max_seeds_per_provider !== undefined) {
    process.stdout.write(`  max seeds/prov  ${summary.max_seeds_per_provider}\n`);
  }
  process.stdout.write(`  timeout         ${summary.timeout_seconds}s\n`);
  if (opts.quiet !== true) process.stdout.write('\n  re-run with --yes to execute.\n');
}

function inboxRunCliError(error: InboxRunError): CliError {
  if (error.kind === 'poll_failed') {
    return new CliError(
      `inbox placement test ${error.resultId} was created, but retrieving its status failed - resume with 'mailgun inbox-placement result ${error.resultId}'. Cause: ${error.detail ?? 'unknown error'}`,
      1,
      error.statusCode
    );
  }

  const cause = error.detail ? ` Cause: ${error.detail}` : '';
  const lead =
    error.kind === 'create_missing_id'
      ? 'the create response did not include a result id'
      : 'the inbox placement create did not complete cleanly and a test may have been created';
  return new CliError(
    `${lead}, and no second create was attempted. Inspect 'mailgun inbox-placement list' manually before deciding whether to create another test.${cause}`,
    1,
    error.statusCode
  );
}

function registerRun(parent: Command): void {
  const run = parent
    .command('run')
    .description('Create and summarize an inbox placement test (sends to seed addresses, consumes quota)')
    .option('--from <address>', 'verified Mailgun from address for the test (required)')
    .option('--subject <subject>', 'subject line for the placement test (required)')
    .option('--html <file>', 'path to the HTML email file to test')
    .option('--template-name <name>', 'domain-level Mailgun Send template name')
    .option('--account-template-name <name>', 'account-level Mailgun Send template name')
    .option('--seed-list <id>', 'existing seed list id (default: Mailgun creates one)')
    .option('--providers <domains>', 'comma-separated provider domains (default: all providers)')
    .option('--sending-ip <ip>', 'account-owned sending IP to use for delivery')
    .option('--sending-ip-pool-id <id>', 'IP pool id whose member IP will deliver the test')
    .option('--max-seeds-per-provider <n>', 'max seeds per provider (0 = no limit)')
    .option('--timeout <seconds>', 'max seconds to poll after creating (0-600, default 300)')
    .option('--dry-run', 'validate and summarize the request without creating anything')
    .option('--yes', 'create the inbox placement test (sends to seeds, consumes quota)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --dry-run\n  mailgun inbox-placement run --from news@example.com --subject "June campaign" --html ./email.html --yes --json\n'
    );

  addApiOptions(run);

  run.action(async (_options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);

      // 1) Write guard first: makes intent explicit before anything else.
      const mode = resolveWriteMode({ dryRun: opts.dryRun === true, yes: opts.yes === true });

      // 2) Validate + build the request. All input errors reject before any
      //    network call, so a bad artifact can never create a placement test.
      const from = optionalTrimmedString(opts.from);
      if (!from) throw new UsageError('--from is required and must be a non-empty address');
      const subject = optionalTrimmedString(opts.subject);
      if (!subject) throw new UsageError('--subject is required and must be non-empty');

      const { content, htmlSource } = resolveContentSource(opts);
      const providers = parseProvidersList(opts.providers);
      const seedList = optionalTrimmedString(opts.seedList);
      const sendingIp = optionalTrimmedString(opts.sendingIp);
      const sendingIpPoolId = optionalTrimmedString(opts.sendingIpPoolId);
      const maxSeedsPerProvider = parseMaxSeedsPerProvider(opts.maxSeedsPerProvider);
      const timeoutSeconds = parseTimeoutSeconds(opts.timeout) ?? 300;

      const create: InboxCreateInput = {
        from,
        subject,
        content,
        seedList,
        providers,
        sendingIp,
        sendingIpPoolId,
        maxSeedsPerProvider
      };

      // 3) Dry run: never reads credentials, never touches the network.
      if (mode === 'dry-run') {
        const summary = buildDryRunSummary(create, htmlSource, timeoutSeconds);
        if (opts.json === true) printJSON(summary);
        else printDryRun(summary, mergedOpts(command));
        return;
      }

      // 4) Execute: one POST, then GET-only polling.
      const runtime = resolveRuntime(command, { requireApiKey: true });
      spinner.start('Creating inbox placement test...');
      let output: InboxRunOutput;
      try {
        output = await runInboxPlacementTest({
          apiKey: runtime.apiKey!,
          baseUrl: runtime.baseUrl,
          create,
          timeoutSeconds
        });
      } catch (error) {
        if (error instanceof InboxRunError) throw inboxRunCliError(error);
        throw error;
      }
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
  registerRun(inbox);

  inbox.action(() => {
    printError(
      'missing subcommand - try `mailgun inbox-placement list`, `mailgun inbox-placement result`, or `mailgun inbox-placement run`'
    );
    process.exitCode = 2;
  });
}
