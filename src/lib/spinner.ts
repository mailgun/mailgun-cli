import ora, { type Ora } from 'ora';
import { isTTY } from './output.js';

// A spinner that respects output discipline: it only animates on a real TTY when
// neither --json nor --quiet is set. All methods are safe to call regardless;
// when inactive they are no-ops, so callers never need to branch.
//
// Discipline guaranteed by this wrapper:
//   - never writes to stdout (ora writes to stderr)
//   - stop()/succeed()/fail() must be called before any data is written
//   - an exit failsafe clears any lingering spinner
export interface CliSpinner {
  start(text?: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

const NOOP_SPINNER: CliSpinner = {
  start: () => {},
  succeed: () => {},
  fail: () => {},
  stop: () => {}
};

export function createSpinner(opts: { json?: boolean; quiet?: boolean }): CliSpinner {
  if (opts.json === true || opts.quiet === true || !isTTY()) {
    return NOOP_SPINNER;
  }

  let instance: Ora | null = null;
  const failsafe = () => {
    if (instance?.isSpinning) instance.stop();
  };
  process.on('exit', failsafe);

  return {
    start(text) {
      instance = ora({ text, stream: process.stderr }).start();
    },
    succeed(text) {
      instance?.succeed(text);
      instance = null;
    },
    fail(text) {
      instance?.fail(text);
      instance = null;
    },
    stop() {
      instance?.stop();
      instance = null;
    }
  };
}
