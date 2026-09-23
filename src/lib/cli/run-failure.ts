import type { RunFailureKind } from '../core/write-run.js';
import { CliError } from './output.js';

export interface RunVocabulary {
  testNoun: string;
  idNoun: string;
  createNoun: string;
  resumeCommand: string;
  listCommand: string;
}

export interface RunFailure {
  kind: RunFailureKind;
  statusCode?: number;
  createdId?: string;
  detail?: string;
}

export function runFailureCliError(vocab: RunVocabulary, failure: RunFailure, createNote = ''): CliError {
  if (failure.kind === 'poll_failed') {
    return new CliError(
      `${vocab.testNoun} ${failure.createdId} was created, but retrieving its status failed - resume with '${vocab.resumeCommand} ${failure.createdId}'. Cause: ${failure.detail ?? 'unknown error'}`,
      1,
      failure.statusCode
    );
  }

  const cause = failure.detail ? ` Cause: ${failure.detail}` : '';
  const lead =
    failure.kind === 'create_missing_id'
      ? `the create response did not include a ${vocab.idNoun}`
      : `the ${vocab.createNoun} did not complete cleanly and a test may have been created`;
  return new CliError(
    `${lead}, and no second create was attempted. Inspect '${vocab.listCommand}' manually before deciding whether to create another test.${createNote}${cause}`,
    1,
    failure.statusCode
  );
}
