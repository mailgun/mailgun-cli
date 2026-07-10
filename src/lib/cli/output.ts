import { Chalk } from 'chalk';

// Exit code taxonomy:
//   1 = runtime failure (non-2xx API response, network error, unexpected server response)
//   2 = usage/config error (missing/invalid input, conflicting flags, missing key, bad region)
export class CliError extends Error {
  readonly exitCode: number;
  // Upstream HTTP status when this error came from a non-2xx API response.
  readonly statusCode?: number;
  constructor(message: string, exitCode = 1, statusCode?: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.statusCode = statusCode;
  }
}

// Usage/config errors always exit 2.
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export function printJSON(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

// Centralized error handling for command actions: errors always go to stderr,
// never stdout, and the process exit code follows the taxonomy above.
export function handleCommandError(error: unknown): void {
  if (error instanceof CliError) {
    printError(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  printError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

export function shouldDecorate(opts: { json?: boolean; quiet?: boolean }): boolean {
  return isTTY() && opts.json !== true && opts.quiet !== true;
}

export function chalkFor(opts: { json?: boolean; quiet?: boolean }) {
  return new Chalk({ level: shouldDecorate(opts) ? 1 : 0 });
}

export function truncate(value: string | null | undefined, maxLength: number): string {
  if (!value) return '-';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function pad(value: string | number | null | undefined, width: number): string {
  return String(value ?? '-').padEnd(width, ' ');
}

export function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
