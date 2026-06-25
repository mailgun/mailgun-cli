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
    .positive('--interval must be a positive integer'),
  limit: z.coerce
    .number()
    .int('--limit must be a positive integer')
    .positive('--limit must be a positive integer')
    .max(300, '--limit must be 300 or less')
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

function maxEventTimestampMs(events: NormalizedEvent[], current = 0): number {
  let latestMs = current;
  for (const event of events) {
    const ms = Date.parse(event.timestamp);
    if (Number.isFinite(ms)) latestMs = Math.max(latestMs, ms);
  }
  return latestMs;
}

function beginSecFromMs(latestMs: number): number {
  return latestMs > 0 ? Math.floor(latestMs / 1000) : Math.floor(Date.now() / 1000);
}

function buildForwardPollUrl(
  path: string,
  eventExpr: string,
  beginSec: number,
  limit: number,
  baseUrl: string
): string {
  return buildMailgunUrl(path, { event: eventExpr, ascending: 'yes', begin: beginSec, limit }, baseUrl);
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
      const path = `/v3/${encodeURIComponent(domain)}/events`;
      // Mailgun's events API expects a single `event` filter expression with
      // types joined by OR; repeated `event` params match nothing.
      const eventExpr = filter.join(' OR ');
      const dedupe = new Set<string>();

      // Single fetch: most recent `limit` events, newest first (descending).
      if (opts.tail !== true) {
        const url = buildMailgunUrl(path, { event: eventExpr, limit, ascending: 'no' }, runtime.baseUrl);
        const page = await fetchEventsPage(url, apiKey, domain);
        for (const event of page.events) writeEvent(event, opts);
        return;
      }

      // Tail: show a recent backlog, then poll forward for new events.
      if (opts.json !== true && opts.quiet !== true) {
        process.stdout.write(`Tailing events for ${domain} - Ctrl+C to stop\n`);
      }

      process.once('SIGINT', () => {
        if (opts.json !== true && opts.quiet !== true) process.stdout.write('\nStopped.\n');
        process.exit(0);
      });

      // Backlog: fetch the most recent `limit` events (descending) and print them
      // chronologically so new events append naturally below.
      const backlogUrl = buildMailgunUrl(path, { event: eventExpr, limit, ascending: 'no' }, runtime.baseUrl);
      const backlog = await fetchEventsPage(backlogUrl, apiKey, domain);
      let latestMs = 0;
      for (const event of [...backlog.events].reverse()) {
        const key = tailDedupeKey(event);
        if (!dedupe.has(key)) {
          dedupe.add(key);
          writeEvent(event, opts);
        }
        latestMs = maxEventTimestampMs([event], latestMs);
      }

      // Poll forward: drain each interval's pages via paging.next, then reset the
      // cursor from the newest timestamp seen so the next cycle does not stick on
      // an exhausted page URL.
      let beginSec = beginSecFromMs(latestMs);
      while (true) {
        await sleep(interval);
        let pollUrl = buildForwardPollUrl(path, eventExpr, beginSec, limit, runtime.baseUrl);
        do {
          const page = await fetchEventsPage(pollUrl, apiKey, domain);
          for (const event of page.events) {
            const key = tailDedupeKey(event);
            if (dedupe.has(key)) continue;
            dedupe.add(key);
            writeEvent(event, opts);
            latestMs = maxEventTimestampMs([event], latestMs);
          }
          if (!page.next) break;
          pollUrl = page.next;
        } while (true);
        beginSec = beginSecFromMs(latestMs);
      }
    } catch (error) {
      handleCommandError(error);
    }
  });
}
