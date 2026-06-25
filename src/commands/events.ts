import { Command } from 'commander';
import { z } from 'zod';
import { mergedOpts, resolveRuntime } from '../lib/runtime.js';
import { buildMailgunUrl, fetchMailgunJSON } from '../lib/mailgun.js';
import { eventSymbol, formatEventTime, normalizeEvent, tailDedupeKey, type NormalizedEvent } from '../lib/events.js';
import { addApiOptions } from './shared-options.js';
import { chalkFor, handleCommandError, pad, truncate, UsageError } from '../lib/output.js';

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
    .positive('--interval must be a positive integer')
});

interface EventsResponse {
  items?: unknown[];
  paging?: { next?: string };
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

async function fetchEventsPage(url: string, apiKey: string, domain: string): Promise<{ events: NormalizedEvent[]; next?: string }> {
  const response = await fetchMailgunJSON<EventsResponse>(url, apiKey, 'events');
  return {
    events: (response.items ?? []).map((event) => normalizeEvent(event, domain)),
    next: response.paging?.next
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerEvents(program: Command): void {
  const command = program
    .command('events')
    .description('Stream live delivery events')
    .option('--tail', 'enable continuous polling mode')
    .option('--filter <types>', 'comma-separated event types', 'delivered,failed,opened,clicked,complained')
    .option('--interval <ms>', 'polling interval in milliseconds', '3000')
    .addHelpText(
      'after',
      '\nExamples:\n  mailgun events --domain acme.com\n  mailgun events --domain acme.com --json\n  mailgun events --domain acme.com --tail\n'
    );

  addApiOptions(command, { domain: true });

  command.action(async (_options, cmd: Command) => {
    const opts = mergedOpts(cmd);

    try {
      const parsed = eventsInputSchema.safeParse({ filter: opts.filter, interval: opts.interval });
      if (!parsed.success) {
        throw new UsageError(parsed.error.issues[0]?.message ?? 'invalid input');
      }
      const { filter, interval } = parsed.data;

      const runtime = resolveRuntime(cmd, { requireApiKey: true, requireDomain: true });
      const dedupe = new Set<string>();
      let nextUrl = buildMailgunUrl(
        `/v3/${encodeURIComponent(runtime.domain!)}/events`,
        { event: filter, limit: 10, ascending: 'no' },
        runtime.baseUrl
      );

      if (opts.tail === true && opts.json !== true && opts.quiet !== true) {
        process.stdout.write(`Tailing events for ${runtime.domain} - Ctrl+C to stop\n`);
      }

      let stopped = false;
      const handleSigint = () => {
        stopped = true;
        if (opts.json !== true && opts.quiet !== true) process.stdout.write('\nStopped.\n');
        process.exit(0);
      };

      if (opts.tail === true) process.once('SIGINT', handleSigint);

      while (!stopped) {
        const currentPage = await fetchEventsPage(nextUrl, runtime.apiKey!, runtime.domain!);

        for (const event of currentPage.events) {
          const key = tailDedupeKey(event);
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          writeEvent(event, opts);
        }

        if (opts.tail !== true) break;
        nextUrl = currentPage.next ?? nextUrl;
        await sleep(interval);
      }
    } catch (error) {
      handleCommandError(error);
    }
  });
}
