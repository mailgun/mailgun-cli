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
