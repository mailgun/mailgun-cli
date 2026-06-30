import type { Command } from 'commander';
import { UsageError } from '../cli/output.js';
import { regionBaseUrl, type Region } from './mailgun.js';

export interface RuntimeContext {
  apiKey: string | null;
  region: Region;
  baseUrl: string;
  domain: string | null;
  json: boolean;
  quiet: boolean;
}

// Merge subcommand and parent options so post-subcommand flags work in either
// form: `mailgun metrics summary --json` and `mailgun --json metrics summary`.
// Precedence: subcommand opts override parent opts.
export function mergedOpts(command: Command): Record<string, unknown> {
  let parent = command.parent;
  let merged: Record<string, unknown> = {};
  const chain: Command[] = [];
  while (parent) {
    chain.unshift(parent);
    parent = parent.parent;
  }
  for (const cmd of chain) merged = { ...merged, ...cmd.opts() };
  return { ...merged, ...command.opts() };
}

// Resolve region from opts, then env, defaulting to `us`. Accepts us/eu
// case-insensitively; anything else is a usage error (exit 2).
export function resolveRegion(value: unknown): Region {
  const raw = typeof value === 'string' && value.length > 0 ? value : process.env.MAILGUN_API_REGION;
  if (raw === undefined || raw === null || raw === '') return 'us';
  const normalized = String(raw).toLowerCase();
  if (normalized !== 'us' && normalized !== 'eu') {
    throw new UsageError(`invalid region "${raw}" - use "us" or "eu"`);
  }
  return normalized;
}

export interface RuntimeOptions {
  requireApiKey?: boolean;
  requireDomain?: boolean;
}

// Resolve the shared runtime context for an API command. Region routing is kept
// separate from auth: API keys are not region-scoped.
export function resolveRuntime(command: Command, options: RuntimeOptions = {}): RuntimeContext {
  const { requireApiKey = true, requireDomain = false } = options;
  const opts = mergedOpts(command);

  const region = resolveRegion(opts.region);
  const apiKey = (opts.apiKey as string | undefined) ?? process.env.MAILGUN_API_KEY ?? null;
  const domain = (opts.domain as string | undefined) ?? process.env.MAILGUN_DOMAIN ?? null;

  if (requireApiKey && !apiKey) {
    throw new UsageError('MAILGUN_API_KEY is not set (or pass --api-key)');
  }
  if (requireDomain && !domain) {
    throw new UsageError('--domain is required (or set MAILGUN_DOMAIN)');
  }

  return {
    apiKey,
    region,
    baseUrl: regionBaseUrl(region),
    domain,
    json: opts.json === true,
    quiet: opts.quiet === true
  };
}
