import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { mergedOpts, resolveRuntime } from '../lib/core/runtime.js';
import {
  parseClientsList,
  parseContentChecks,
  parseLimit,
  parseTimeoutSeconds,
  resolveRequiredArg
} from '../lib/cli/input.js';
import {
  listPreviewTests,
  listPreviewClients,
  type PreviewListOutput,
  type PreviewClientsOutput
} from '../lib/products/inspect/preview.js';
import {
  getPreviewIssues,
  getPreviewRender,
  type PreviewIssuesOutput,
  type PreviewRenderOutput
} from '../lib/products/inspect/preview-details.js';
import {
  CHECK_NAMES,
  getPreviewQa,
  runPreviewTest,
  PreviewRunError,
  type CheckName,
  type PreviewCreateInput,
  type PreviewQaOutput
} from '../lib/products/inspect/preview-qa.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, CliError, handleCommandError, printError, printJSON, UsageError } from '../lib/cli/output.js';
import { resolveWriteMode } from '../lib/cli/write-guard.js';
import { createSpinner } from '../lib/cli/spinner.js';
import type { CommandDescriptor } from './descriptor.js';

// Mailgun's published V2 schema does not define an HTML maximum. Operators may
// configure a local preflight ceiling without presenting it as upstream policy.
function maxHtmlBytes(): number | null {
  const raw = process.env.MAILGUN_PREVIEW_MAX_HTML_BYTES;
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (parsed > 0) return parsed;
  }
  return null;
}

interface HtmlSource {
  path: string;
  html: string;
  bytes: number;
  sha256: string;
}

// Read the HTML payload from a file (file-only; never stdin, never inline). All
// failures are usage errors raised before any network call so a bad artifact
// can never consume preview quota.
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
  const limit = maxHtmlBytes();
  if (limit !== null && bytes > limit) {
    throw new UsageError(
      `--html file '${path}' is ${bytes} bytes, over the configured ${limit}-byte MAILGUN_PREVIEW_MAX_HTML_BYTES limit`
    );
  }
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  return { path, html, bytes, sha256 };
}

export const PREVIEW_DESCRIPTORS: CommandDescriptor[] = [
  {
    command: 'preview issues',
    mode: 'read',
    description: 'Explain individual findings for an email preview QA check',
    product: 'Inspect',
    flags: ['--test-id', '--check', '--region', '--json', '--quiet'],
    outputFields: ['test_id', 'check', 'result_id', 'status', 'totals', 'issues', 'data_gaps'],
    examples: ['mailgun preview issues preview_123 --check accessibility']
  },
  {
    command: 'preview render',
    mode: 'read',
    description: 'Inspect or download one client render from an email preview test',
    product: 'Inspect',
    mcpTool: 'get_preview_client_result',
    flags: ['--test-id', '--client-id', '--variant', '--output', '--region', '--json', '--quiet'],
    outputFields: [
      'test_id',
      'client_id',
      'display_name',
      'client',
      'os',
      'browser',
      'category',
      'status',
      'available_variants',
      'selected_variant',
      'output_path',
      'bytes',
      'data_gaps'
    ],
    examples: [
      'mailgun preview render preview_123 gmail_chrome',
      'mailgun preview render preview_123 gmail_chrome --output ./gmail.png',
      'mailgun preview render preview_123 gmail_chrome --variant default --output ./gmail.png'
    ]
  },
  {
    command: 'preview list',
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
    mode: 'read',
    description: 'Poll and summarize an email preview QA result',
    product: 'Inspect',
    mcpTool: 'get_email_preview_qa',
    flags: ['--test-id', '--timeout', '--region', '--json', '--quiet'],
    outputFields: [
      'test_id',
      'status',
      'timed_out',
      'summary',
      'clients',
      'checks',
      'issue_counts',
      'warnings',
      'data_gaps'
    ],
    examples: [
      'mailgun preview result --test-id preview_123 --json',
      'mailgun preview result preview_123 --timeout 0 --json'
    ]
  },
  {
    command: 'preview clients',
    mode: 'read',
    description: 'List email clients available for preview tests',
    product: 'Inspect',
    mcpTool: 'list_preview_clients',
    flags: ['--region', '--json', '--quiet'],
    outputFields: ['clients', 'data_gaps'],
    examples: ['mailgun preview clients --json']
  },
  {
    command: 'preview run',
    mode: 'write',
    description: 'Create and summarize an email preview QA test from an HTML file (consumes quota)',
    product: 'Inspect',
    mcpTool: 'run_email_preview_qa',
    flags: [
      '--subject',
      '--html',
      '--clients',
      '--content-checks',
      '--reference-id',
      '--timeout',
      '--dry-run',
      '--yes',
      '--region',
      '--json',
      '--quiet'
    ],
    outputFields: [
      'test_id',
      'status',
      'timed_out',
      'summary',
      'clients',
      'checks',
      'issue_counts',
      'warnings',
      'data_gaps'
    ],
    examples: [
      'mailgun preview run --subject "June campaign" --html ./email.html --dry-run',
      'mailgun preview run --subject "June campaign" --html ./email.html --yes --json',
      'mailgun preview run --subject "Promo" --html ./promo.html --clients gmail_chrome,apple_mail --yes'
    ]
  }
];

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

function printResult(output: PreviewQaOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) process.stdout.write(`${chalk.bold(`Preview QA - ${output.test_id}`)}\n\n`);
  const s = output.summary;
  process.stdout.write(`  status      ${output.status}${output.timed_out ? ' (timed out)' : ''}\n`);
  process.stdout.write(
    `  clients     ${s.completed}/${s.total_clients} complete, ${s.processing} processing, ${s.bounced} bounced\n`
  );

  const c = output.checks;
  process.stdout.write('\n  checks:\n');
  process.stdout.write(`    link_validation   ${c.link_validation.status.padEnd(13)} failures ${c.link_validation.failures}\n`);
  process.stdout.write(`    image_validation  ${c.image_validation.status.padEnd(13)} failures ${c.image_validation.failures}\n`);
  process.stdout.write(
    `    accessibility     ${c.accessibility.status.padEnd(13)} failures ${c.accessibility.failures}, needs_review ${c.accessibility.needs_review}\n`
  );
  process.stdout.write(`    code_analysis     ${c.code_analysis.status.padEnd(13)} features ${c.code_analysis.count} (${c.code_analysis.instances} instances)\n`);
  process.stdout.write(`\n  total issues ${output.issue_counts.total}\n`);

  for (const w of output.warnings) {
    process.stdout.write(`  ${chalk.dim(`warning: ${w.message ?? w.name ?? 'unknown'}`)}\n`);
  }
  for (const gap of output.data_gaps) process.stdout.write(`  ${chalk.dim(`data gap: ${gap.message}`)}\n`);
  if (opts.quiet !== true) process.stdout.write('\n  (use --json for full counts and references)\n');
}

function printIssues(output: PreviewIssuesOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) {
    process.stdout.write(`${chalk.bold(`${output.check} findings - ${output.test_id}`)}\n`);
    process.stdout.write(
      `  ${output.totals.confirmed} confirmed, ${output.totals.needs_review} needs review\n\n`
    );
  }
  if (output.status === 'processing') {
    process.stdout.write('Result is still processing.\n');
    return;
  }
  if (output.issues.length === 0) {
    process.stdout.write('No findings.\n');
    return;
  }
  for (const issue of output.issues) {
    const label = issue.kind === 'failure' ? issue.impact ?? 'unknown' : 'needs review';
    process.stdout.write(`${chalk.bold(`[${label}] ${issue.rule ?? 'Unknown rule'}`)}\n`);
    if (issue.description) process.stdout.write(`  ${issue.description}\n`);
    const location = [
      issue.line === null ? null : `line ${issue.line}`,
      issue.column === null ? null : `column ${issue.column}`,
      ...issue.target
    ]
      .filter(Boolean)
      .join(' · ');
    if (location) process.stdout.write(`  ${chalk.dim(location)}\n`);
    if (issue.url) process.stdout.write(`  ${issue.url}\n`);
    if (issue.snippet) process.stdout.write(`  ${chalk.dim(issue.snippet)}\n`);
    process.stdout.write('\n');
  }
}

function printRender(output: PreviewRenderOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) {
    const title = output.display_name ?? output.client_id;
    process.stdout.write(`${chalk.bold(title)}\n`);
  }
  process.stdout.write(`  client id   ${output.client_id}\n`);
  process.stdout.write(`  client      ${output.client ?? '-'}\n`);
  process.stdout.write(`  os          ${output.os ?? '-'}\n`);
  process.stdout.write(`  status      ${output.status ?? '-'}\n`);
  process.stdout.write(`  variants    ${output.available_variants.join(', ') || '-'}\n`);
  if (output.output_path) {
    process.stdout.write(`  saved       ${output.output_path}\n`);
    process.stdout.write(`  bytes       ${output.bytes ?? 0}\n`);
  }
}

function printClients(output: PreviewClientsOutput, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (output.clients.length === 0) {
    if (opts.quiet !== true) process.stdout.write('No preview clients were returned.\n');
    for (const gap of output.data_gaps) process.stdout.write(`  ${chalk.dim(`data gap: ${gap.message}`)}\n`);
    return;
  }
  for (const c of output.clients) {
    const tags = [c.default ? 'default' : null, c.free ? 'free' : null].filter(Boolean).join(', ');
    process.stdout.write(`${chalk.bold(c.id)}${tags ? chalk.dim(`  (${tags})`) : ''}\n`);
    process.stdout.write(`  client    ${c.client ?? '-'}\n`);
    process.stdout.write(`  os        ${c.os ?? '-'}\n`);
    process.stdout.write(`  category  ${c.category ?? '-'}\n`);
  }
  if (opts.quiet !== true) process.stdout.write(`\n  ${output.clients.length} client(s). Pass these IDs to --clients on a preview test.\n`);
}

function registerClients(parent: Command): void {
  const clients = parent
    .command('clients')
    .description('List email clients available for preview tests')
    .addHelpText('after', '\nExamples:\n  mailgun preview clients --json\n');

  addApiOptions(clients);

  clients.action(async (_options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const runtime = resolveRuntime(command, { requireApiKey: true });

      spinner.start('Fetching preview clients...');
      const output = await listPreviewClients({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl
      });
      spinner.stop();

      if (runtime.json) printJSON(output);
      else printClients(output, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });
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
    .description('Poll and summarize an email preview QA result')
    .argument('[test_id]', 'email preview test ID (alternative to --test-id)')
    .option('--test-id <test_id>', 'email preview test ID (canonical)')
    .option('--timeout <seconds>', 'max seconds to poll for the render/checks to settle (0-600, default 120)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun preview result preview_123 --json\n  mailgun preview result --test-id preview_123 --json\n  mailgun preview result preview_123 --timeout 0 --json\n'
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
      const timeoutSeconds = parseTimeoutSeconds(opts.timeout);
      const runtime = resolveRuntime(command, { requireApiKey: true });

      spinner.start('Polling preview QA...');
      const output = await getPreviewQa({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        testId,
        timeoutSeconds
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

function registerIssues(parent: Command): void {
  const issues = parent
    .command('issues')
    .description('Explain individual findings for one preview QA check')
    .argument('[test_id]', 'email preview test ID (alternative to --test-id)')
    .option('--test-id <test_id>', 'email preview test ID')
    .requiredOption('--check <name>', 'check to explain (link_validation, image_validation, or accessibility)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun preview issues preview_123 --check accessibility\n  mailgun preview issues --test-id preview_123 --check accessibility --json\n'
    );

  addApiOptions(issues);

  issues.action(async (positional: string | undefined, _options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const testId = resolveRequiredArg({
        positional,
        flag: typeof opts.testId === 'string' ? opts.testId : undefined,
        flagName: '--test-id',
        missingMessage: "a test id is required (positional or --test-id; get one from 'mailgun preview list')"
      });
      const check = typeof opts.check === 'string' ? opts.check.trim() : '';
      if (!['link_validation', 'image_validation', 'accessibility'].includes(check)) {
        throw new UsageError('--check must be link_validation, image_validation, or accessibility');
      }
      const runtime = resolveRuntime(command, { requireApiKey: true });
      spinner.start('Fetching preview findings...');
      const output = await getPreviewIssues({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        testId,
        check: check as CheckName
      });
      spinner.stop();
      if (runtime.json) printJSON(output);
      else printIssues(output, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });
}

function registerRender(parent: Command): void {
  const render = parent
    .command('render')
    .description('Inspect or download one client render from a preview test')
    .argument('[test_id]', 'email preview test ID (alternative to --test-id)')
    .argument('[client_id]', 'preview client ID (alternative to --client-id)')
    .option('--test-id <test_id>', 'email preview test ID')
    .option('--client-id <client_id>', 'preview client ID')
    .option('--variant <name>', 'API-provided screenshot key to download, such as default')
    .option('--output <path>', 'local path for the downloaded image; chooses a default asset and refuses to overwrite')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun preview render preview_123 gmail_chrome\n  mailgun preview render preview_123 gmail_chrome --output ./gmail.png\n  mailgun preview render preview_123 gmail_chrome --variant default --output ./gmail.png\n'
    );

  addApiOptions(render);

  render.action(async (
    positionalTestId: string | undefined,
    positionalClientId: string | undefined,
    _options,
    command: Command
  ) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const testId = resolveRequiredArg({
        positional: positionalTestId,
        flag: typeof opts.testId === 'string' ? opts.testId : undefined,
        flagName: '--test-id',
        missingMessage: "a test id is required (positional or --test-id; get one from 'mailgun preview list')"
      });
      const clientId = resolveRequiredArg({
        positional: positionalClientId,
        flag: typeof opts.clientId === 'string' ? opts.clientId : undefined,
        flagName: '--client-id',
        missingMessage: "a client id is required (positional or --client-id; get one from 'mailgun preview clients')"
      });
      const runtime = resolveRuntime(command, { requireApiKey: true });
      spinner.start('Fetching client render...');
      const output = await getPreviewRender({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        testId,
        clientId,
        variant: typeof opts.variant === 'string' ? opts.variant.trim() : undefined,
        outputPath: typeof opts.output === 'string' ? opts.output.trim() : undefined
      });
      spinner.stop();
      if (runtime.json) printJSON(output);
      else printRender(output, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });
}

interface DryRunSummary {
  dry_run: true;
  action: 'run_email_preview_qa';
  will_consume_quota: true;
  subject: string;
  source: { type: 'html'; path: string; bytes: number; sha256: string };
  content_checks: string[];
  timeout_seconds: number;
  clients?: string[];
  uses_mailgun_default_clients?: true;
  reference_id?: string;
}

function buildDryRunSummary(
  create: PreviewCreateInput,
  source: HtmlSource,
  timeoutSeconds: number
): DryRunSummary {
  const summary: DryRunSummary = {
    dry_run: true,
    action: 'run_email_preview_qa',
    will_consume_quota: true,
    subject: create.subject,
    source: { type: 'html', path: source.path, bytes: source.bytes, sha256: source.sha256 },
    content_checks: create.contentChecks ? [...create.contentChecks] : [...CHECK_NAMES],
    timeout_seconds: timeoutSeconds
  };
  if (create.clients && create.clients.length > 0) summary.clients = [...create.clients];
  else summary.uses_mailgun_default_clients = true;
  if (create.referenceId) summary.reference_id = create.referenceId;
  return summary;
}

function previewRunCliError(error: PreviewRunError): CliError {
  const referenceCorrelationNote = error.referenceId
    ? ` reference_id '${error.referenceId}' is correlation only and cannot confirm whether a test was created.`
    : '';

  if (error.kind === 'poll_failed') {
    return new CliError(
      `preview test ${error.testId} was created, but retrieving its status failed - resume with 'mailgun preview result ${error.testId}'. Cause: ${error.detail ?? 'unknown error'}`,
      1,
      error.statusCode
    );
  }

  const cause = error.detail ? ` Cause: ${error.detail}` : '';
  const lead =
    error.kind === 'create_missing_id'
      ? 'the create response did not include a test id'
      : 'the preview create did not complete cleanly and a test may have been created';
  return new CliError(
    `${lead}, and no second create was attempted. Inspect 'mailgun preview list' manually before deciding whether to create another test.${referenceCorrelationNote}${cause}`,
    1,
    error.statusCode
  );
}

function printDryRun(summary: DryRunSummary, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  process.stdout.write(`${chalk.bold('preview run (dry run)')}\n`);
  process.stdout.write(`  ${chalk.dim('executing this request will create a remote Inspect test and consume preview quota')}\n\n`);
  process.stdout.write(`  subject         ${summary.subject}\n`);
  process.stdout.write(`  html path       ${summary.source.path}\n`);
  process.stdout.write(`  html bytes      ${summary.source.bytes}\n`);
  process.stdout.write(`  html sha256     ${summary.source.sha256}\n`);
  process.stdout.write(
    `  clients         ${summary.clients ? summary.clients.join(', ') : 'Mailgun defaults'}\n`
  );
  process.stdout.write(`  content checks  ${summary.content_checks.join(', ')}\n`);
  if (summary.reference_id) process.stdout.write(`  reference id    ${summary.reference_id}\n`);
  process.stdout.write(`  timeout         ${summary.timeout_seconds}s\n`);
  if (opts.quiet !== true) process.stdout.write('\n  re-run with --yes to execute.\n');
}

function registerRun(parent: Command): void {
  const run = parent
    .command('run')
    .description('Create and summarize an email preview QA test from an HTML file (consumes quota)')
    .option('--subject <subject>', 'subject line for the preview test (required)')
    .option('--html <file>', 'path to the HTML email file to test (required)')
    .option('--clients <ids>', 'comma-separated client ids (default: Mailgun default clients)')
    .option('--content-checks <names>', 'comma-separated checks or "none" (default: all four)')
    .option('--reference-id <id>', 'caller-supplied correlation id (not an idempotency or lookup key)')
    .option('--timeout <seconds>', 'max seconds to poll after creating (0-600, default 300)')
    .option('--dry-run', 'validate and summarize the request without creating anything')
    .option('--yes', 'create the preview test (consumes quota)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun preview run --subject "June campaign" --html ./email.html --dry-run\n  mailgun preview run --subject "June campaign" --html ./email.html --yes --json\n'
    );

  addApiOptions(run);

  run.action(async (_options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);

      // 1) Write guard first: makes intent explicit before anything else.
      const mode = resolveWriteMode({ dryRun: opts.dryRun === true, yes: opts.yes === true });

      // 2) Validate + build the request. All input errors reject before any
      //    network call, so a bad artifact can never consume quota.
      const subject = typeof opts.subject === 'string' ? opts.subject.trim() : '';
      if (subject === '') throw new UsageError('--subject is required and must be non-empty');
      const source = readHtmlSource(opts.html);
      const clients = parseClientsList(opts.clients);
      const contentChecks = parseContentChecks(opts.contentChecks, CHECK_NAMES) as CheckName[] | undefined;
      const referenceId =
        typeof opts.referenceId === 'string' && opts.referenceId.trim() !== ''
          ? opts.referenceId.trim()
          : undefined;
      const timeoutSeconds = parseTimeoutSeconds(opts.timeout) ?? 300;

      const create: PreviewCreateInput = { subject, html: source.html, clients, contentChecks, referenceId };

      // 3) Dry run: never reads credentials, never touches the network.
      if (mode === 'dry-run') {
        const summary = buildDryRunSummary(create, source, timeoutSeconds);
        if (opts.json === true) printJSON(summary);
        else printDryRun(summary, mergedOpts(command));
        return;
      }

      // 4) Execute: one POST, then GET-only polling.
      const runtime = resolveRuntime(command, { requireApiKey: true });
      spinner.start('Creating preview test...');
      let output: PreviewQaOutput;
      try {
        output = await runPreviewTest({
          apiKey: runtime.apiKey!,
          baseUrl: runtime.baseUrl,
          create,
          timeoutSeconds
        });
      } catch (error) {
        if (error instanceof PreviewRunError) throw previewRunCliError(error);
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

export function registerPreview(program: Command): void {
  const preview = program.command('preview').description('Email preview (Inspect) commands');
  registerList(preview);
  registerResult(preview);
  registerIssues(preview);
  registerRender(preview);
  registerClients(preview);
  registerRun(preview);

  preview.action(() => {
    printError(
      'missing subcommand - try `mailgun preview list`, `mailgun preview result`, `mailgun preview issues`, `mailgun preview render`, `mailgun preview clients`, or `mailgun preview run`'
    );
    process.exitCode = 2;
  });
}
