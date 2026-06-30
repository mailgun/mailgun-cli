import { Command } from 'commander';
import { z } from 'zod';
import { resolveRuntime, mergedOpts } from '../lib/core/runtime.js';
import { getMetricsSummary, type MetricsSummary } from '../lib/products/send/metrics.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, handleCommandError, percent, printError, printJSON, UsageError } from '../lib/cli/output.js';
import { createSpinner } from '../lib/cli/spinner.js';
import type { CommandDescriptor } from './descriptor.js';

const isoSchema = z.string().datetime({ offset: true, message: 'must be an ISO 8601 timestamp' });

export const METRICS_DESCRIPTORS: CommandDescriptor[] = [
  {
    command: 'metrics summary',
    mode: 'read',
    description: 'Summarize sending metrics (counts and computed rates) for a domain and window',
    product: 'Send',
    mcpTool: 'get_metrics_summary',
    flags: ['--domain', '--window', '--duration', '--start', '--end', '--timezone', '--region', '--json', '--quiet'],
    outputFields: ['domain', 'metrics_raw', 'rates', 'data_gaps', 'window'],
    examples: [
      'mailgun metrics summary --domain acme.com --json',
      'mailgun metrics summary --domain acme.com --duration 24h --json'
    ]
  }
];

interface ResolvedMetricsInput {
  duration?: string;
  start?: string;
  end?: string;
  timezone?: string;
}

export function validateMetricsInput(opts: Record<string, unknown>): ResolvedMetricsInput {
  const window = typeof opts.window === 'string' ? opts.window : undefined;
  const duration = typeof opts.duration === 'string' ? opts.duration : undefined;
  const start = typeof opts.start === 'string' ? opts.start : undefined;
  const end = typeof opts.end === 'string' ? opts.end : undefined;
  const hasTimezone = opts.timezone !== undefined;
  const timezone = typeof opts.timezone === 'string' ? opts.timezone : undefined;

  if (window !== undefined && duration !== undefined) {
    throw new UsageError('--window and --duration cannot be used together');
  }
  if ((start === undefined) !== (end === undefined)) {
    throw new UsageError('--start and --end must be used together');
  }
  if ((start !== undefined || end !== undefined) && (window !== undefined || duration !== undefined)) {
    throw new UsageError('--start/--end cannot be combined with --window or --duration');
  }
  if (start !== undefined && !isoSchema.safeParse(start).success) {
    throw new UsageError('--start must be an ISO 8601 timestamp');
  }
  if (end !== undefined && !isoSchema.safeParse(end).success) {
    throw new UsageError('--end must be an ISO 8601 timestamp');
  }
  if (hasTimezone && (timezone === undefined || timezone.trim() === '')) {
    throw new UsageError('--timezone cannot be empty');
  }

  return { duration: duration ?? window, start, end, timezone };
}

function printHuman(summary: MetricsSummary, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  if (opts.quiet !== true) {
    process.stdout.write(`${chalk.bold(`Metrics summary - ${summary.domain}`)}\n\n`);
  }
  const m = summary.metrics_raw;
  const rows: Array<[string, string]> = [
    ['Sent', m.sent_count?.toString() ?? '-'],
    ['Delivered', m.delivered_count?.toString() ?? '-'],
    ['Permanent fails', m.permanent_failed_count?.toString() ?? '-'],
    ['Temporary fails', m.temporary_failed_count?.toString() ?? '-'],
    ['Hard bounces', m.hard_bounces_count?.toString() ?? '-'],
    ['Complaints', m.complained_count?.toString() ?? '-'],
    ['Delivered rate', summary.rates.delivered_rate !== undefined ? percent(summary.rates.delivered_rate) : 'n/a'],
    ['Total fail rate', summary.rates.total_fail_rate !== undefined ? percent(summary.rates.total_fail_rate) : 'n/a'],
    ['Complaint rate', summary.rates.complaint_rate !== undefined ? percent(summary.rates.complaint_rate) : 'n/a']
  ];
  for (const [label, value] of rows) {
    process.stdout.write(`  ${label.padEnd(16)} ${value}\n`);
  }
  if (summary.window.start && summary.window.end) {
    process.stdout.write(`  ${'Window'.padEnd(16)} ${summary.window.start} - ${summary.window.end}\n`);
  }
  for (const gap of summary.data_gaps) {
    process.stdout.write(`  ${chalk.dim(`data gap: ${gap.message}`)}\n`);
  }
}

export function registerMetrics(program: Command): void {
  const metrics = program.command('metrics').description('Sending metrics commands');

  const summary = metrics
    .command('summary')
    .description('Summarize sending metrics (counts and computed rates) for a domain and window')
    .option('--window <duration>', 'duration shorthand alias for --duration (e.g. 7d)')
    .option('--duration <duration>', 'duration shorthand (e.g. 24h, 7d); defaults to 24h')
    .option('--start <iso>', 'window start (ISO 8601); requires --end')
    .option('--end <iso>', 'window end (ISO 8601); requires --start')
    .option('--timezone <tz>', 'timezone for the window (e.g. America/New_York)')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun metrics summary --domain acme.com --json\n  mailgun metrics summary --domain acme.com --duration 24h --json\n  mailgun metrics summary --domain acme.com --start 2026-06-01T00:00:00Z --end 2026-06-08T00:00:00Z --json\n'
    );

  addApiOptions(summary, { domain: true });

  summary.action(async (_options, command: Command) => {
    const spinner = createSpinner(mergedOpts(command));
    try {
      const opts = mergedOpts(command);
      const input = validateMetricsInput(opts);
      const runtime = resolveRuntime(command, { requireApiKey: true, requireDomain: true });

      spinner.start('Fetching metrics...');
      const result = await getMetricsSummary({
        apiKey: runtime.apiKey!,
        baseUrl: runtime.baseUrl,
        domain: runtime.domain!,
        ...input
      });
      spinner.stop();

      if (runtime.json) printJSON(result);
      else printHuman(result, runtime);
    } catch (error) {
      spinner.fail();
      handleCommandError(error);
    }
  });

  // Surface a helpful error if `metrics` is run without a subcommand.
  metrics.action(() => {
    printError('missing subcommand - try `mailgun metrics summary`');
    process.exitCode = 2;
  });
}
