import { z } from 'zod';
import { UsageError } from './output.js';

// Shared --limit validator for bounded list commands. Must be a positive integer
// from 1 through 50; rejects 0, negatives, decimals, non-numeric, and > 50.
const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(50);

// Resolve a required identifier supplied either positionally or via a flag,
// mirroring validate-email's address handling. The flag is canonical; a
// positional that conflicts with the flag is a usage error.
export function resolveRequiredArg(params: {
  positional?: string;
  flag?: string;
  flagName: string;
  missingMessage: string;
}): string {
  const { positional, flag, flagName, missingMessage } = params;
  if (flag !== undefined && positional !== undefined && flag !== positional) {
    throw new UsageError(`conflicting ${flagName} arguments`);
  }
  const value = flag ?? positional;
  if (value === undefined || value.trim() === '') {
    throw new UsageError(missingMessage);
  }
  return value;
}

export function parseLimit(value: unknown, defaultValue = 10): number {
  if (value === undefined) return defaultValue;
  // Reject decimals and non-numeric strings before coercion (Number('') === 0).
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw new UsageError('--limit must be a positive integer from 1 to 50');
  }
  const parsed = limitSchema.safeParse(typeof value === 'string' ? Number(value) : value);
  if (!parsed.success) {
    throw new UsageError('--limit must be a positive integer from 1 to 50');
  }
  return parsed.data;
}

// Optional non-negative integer seconds for poll timeouts. Returns undefined
// when omitted (the caller applies its default). 0 means "do not wait" - fetch
// once and return whatever state is available.
export function parseTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw new UsageError('--timeout must be a non-negative integer number of seconds');
  }
  const parsed = z.number().int().min(0).max(600).safeParse(typeof value === 'string' ? Number(value) : value);
  if (!parsed.success) {
    throw new UsageError('--timeout must be a non-negative integer number of seconds (0-600)');
  }
  return parsed.data;
}

// Parse a comma-separated --clients list into a deduped id array. Returns
// undefined when omitted (the caller then relies on Mailgun's default clients).
// An explicitly empty value is a usage error - omit the flag instead.
export function parseClientsList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError('--clients must be a comma-separated list of client ids');
  }
  const ids = value.split(',').map((s) => s.trim());
  if (ids.some((id) => id.length === 0)) {
    throw new UsageError('--clients contained a blank client id; omit the flag to use Mailgun defaults');
  }
  if (ids.length === 0) {
    throw new UsageError('--clients was empty; omit it to use the Mailgun default client set');
  }
  return [...new Set(ids)];
}

// Parse --content-checks. Undefined (omitted) means "run all four" and is
// signalled by returning undefined so the builder applies its default. The
// literal value "none" returns an empty array (run no checks). Unknown names are
// a usage error.
export function parseContentChecks(
  value: unknown,
  allowedNames: readonly string[]
): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError('--content-checks must be a comma-separated list of check names, or "none"');
  }
  const trimmed = value.trim();
  if (trimmed === 'none') return [];
  const names = trimmed.split(',').map((s) => s.trim());
  if (names.some((name) => name.length === 0)) {
    throw new UsageError(
      `--content-checks contained a blank check name; use "none" for no checks or omit it to run all of ${allowedNames.join(', ')}`
    );
  }
  for (const name of names) {
    if (!allowedNames.includes(name)) {
      throw new UsageError(
        `--content-checks contains an unknown check '${name}'; valid names are ${allowedNames.join(', ')} (or "none")`
      );
    }
  }
  return [...new Set(names)];
}
