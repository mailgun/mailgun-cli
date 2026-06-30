import { Command } from 'commander';
import { z } from 'zod';
import { mergedOpts, resolveRuntime } from '../lib/core/runtime.js';
import {
  fetchRecentEvents,
  tailEvents,
  type NormalizedEvent
} from '../lib/products/send/events.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, handleCommandError, pad, truncate, UsageError } from '../lib/cli/output.js';

const ALLOWED_FILTERS = ['delivered', 'failed', 'opened', 'clicked', 'complained'] as const;

const eventsInputSchema = z.object({
  filter: z
    .string()
    .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
    .refine(
      (filters) => filters.length > 0 && filters.every((f) => (ALLOWED_FILTERS as readonly string[]).includes(f)),
      { message: '--filter must contain only delivered, failed, opened, clicked, complained' }
    ),
  interval: z.coerce
    .number()
    .int('--interval must be a positive integer')
    .positive('--interval must be a positive integer'),
  limit: z.coerce
    .number()
    .int('--limit must be a positive integer')
    .positive('--limit must be a positive integer')
    .max(300, '--limit must be 300 or less')
});

function eventSymbol(event: string): string {
  if (event === 'delivered') return '✓';
  if (event === 'failed') return '✗';
  if (event === 'opened') return '↩';
  if (event === 'clicked') return '↪';
  if (event === 'complained') return '!';
  return '-';
}

function formatEventTime(timestamp: string, includeDate = false): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const sec = String(date.getUTCSeconds()).padStart(2, '0');
  return includeDate ? `${yyyy}-${mm}-${dd} ${hh}:${min}` : `${hh}:${min}:${sec}`;
}

function writeJSONEvent(event: NormalizedEvent): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: event.timestamp,
    event: event.event,
    recipient: event.recipient,
    domain: event.domain,
    reason: event.reason,
    code: event.code,
    tags: event.tags
  })}\n`);
}

function writeHumanEvent(event: NormalizedEvent, opts: { json?: boolean; quiet?: boolean }): void {
  const chalk = chalkFor(opts);
  const symbol = eventSymbol(event.event);
  const coloredEvent =
    event.event === 'delivered'
      ? chalk.green(event.event)
      : event.event === 'failed'
        ? chalk.red(event.event)
        : event.event === 'complained'
          ? chalk.yellow(event.event)
          : chalk.gray(event.event);
  const detail = event.reason ?? event.tags?.[0] ?? '-';
  process.stdout.write(
    `${formatEventTime(event.timestamp)}  ${symbol} ${pad(coloredEvent, 10)} ${pad(event.recipient ?? '-', 22)} ${truncate(detail, 42)}\n`
  );
}

function writeEvent(event: NormalizedEvent, opts: { json?: boolean; quiet?: boolean }): void {
  if (opts.json === true) writeJSONEvent(event);
  else writeHumanEvent(event, opts);
}

export function registerEvents(program: Command): void {
  const command = program
    .command('events')
    .description('Stream live delivery events')
    .option('--tail', 'enable continuous polling mode')
    .option('--filter <types>', 'comma-separated event types', 'delivered,failed,opened,clicked,complained')
    .option('--interval <ms>', 'polling interval in milliseconds', '3000')
    .option('--limit <n>', 'recent events to fetch (initial backlog shown before --tail polls)', '10')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun events --domain acme.com\n  mailgun events --domain acme.com --json\n  mailgun events --domain acme.com --tail\n  mailgun events --domain acme.com --tail --limit 5 --interval 5000\n'
    );

  addApiOptions(command, { domain: true });

  command.action(async (_options, cmd: Command) => {
    const opts = mergedOpts(cmd);

    try {
      const parsed = eventsInputSchema.safeParse({ filter: opts.filter, interval: opts.interval, limit: opts.limit });
      if (!parsed.success) {
        throw new UsageError(parsed.error.issues[0]?.message ?? 'invalid input');
      }
      const { filter, interval, limit } = parsed.data;

      const runtime = resolveRuntime(cmd, { requireApiKey: true, requireDomain: true });
      const apiKey = runtime.apiKey!;
      const domain = runtime.domain!;
      // Mailgun's events API expects a single `event` filter expression with
      // types joined by OR; repeated `event` params match nothing.
      const eventExpr = filter.join(' OR ');
      const fetchParams = { apiKey, baseUrl: runtime.baseUrl, domain, eventExpr, limit };

      if (opts.tail !== true) {
        const events = await fetchRecentEvents(fetchParams);
        for (const event of events) writeEvent(event, opts);
        return;
      }

      if (opts.json !== true && opts.quiet !== true) {
        process.stdout.write(`Tailing events for ${domain} - Ctrl+C to stop\n`);
      }

      process.once('SIGINT', () => {
        if (opts.json !== true && opts.quiet !== true) process.stdout.write('\nStopped.\n');
        process.exit(0);
      });

      await tailEvents({ ...fetchParams, interval }, (event) => writeEvent(event, opts));
    } catch (error) {
      handleCommandError(error);
    }
  });
}
