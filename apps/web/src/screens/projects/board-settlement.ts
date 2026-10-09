// SPDX-License-Identifier: AGPL-3.0-only
// Board command outcomes share one report; App-owned assignments reread through custody.
import type { ProjectRow } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { Settlement } from '../../records/use-command.ts';
import { BoardEditCustody } from './board-edit-custody.ts';
import type { BoardEditIntent } from './board-edit-attempt.ts';
import { AssignmentCustody, type AssignmentFields } from '../task/assignment-custody.ts';

export function assignmentSender(options: {
  readonly client: OperationsClient;
  readonly assignment?: AssignmentCustody;
  readonly onSettled: (refused: string | null) => void;
  readonly reload: () => void;
}): (row: ProjectRow, fields: AssignmentFields) => void {
  // Pure isolated row mounts have ephemeral custody; App supplies the durable owner.
  const assignment =
    options.assignment ??
    new AssignmentCustody(options.client, options.client.businessKey, null, true);
  const assign = (row: ProjectRow, fields: AssignmentFields): void => {
    void assignment.choose(row.id, row.revision, fields).then((answer) => {
      if (answer === undefined) return answer;
      options.onSettled(refusalOf(answer));
      if (options.assignment === undefined) options.reload();
      return answer;
    });
  };
  return assign;
}

export function boardEditSender(options: {
  readonly client: OperationsClient;
  readonly edits?: BoardEditCustody;
  readonly onSettled: (refused: string | null) => void;
  readonly reload: () => void;
}): (row: ProjectRow, intent: BoardEditIntent) => boolean {
  const custody =
    options.edits ?? new BoardEditCustody(options.client, options.client.businessKey, null, true);
  if (options.edits === undefined)
    custody.settled((_entry, answer) => {
      options.onSettled(refusalOf(answer));
      options.reload();
    });
  return (row, intent) => custody.choose(intent, row.revision);
}

/** What the board says about a write: nothing when it landed, else the server's words. */
function refusalOf(settled: Settlement): string | null {
  if (settled.kind === 'ok') return null;
  if (settled.kind === 'unknown') {
    return `The change may not have been stored: ${settled.because} Check the row before trying again.`;
  }
  return `The change was not made: ${settled.because}`;
}
