// SPDX-License-Identifier: AGPL-3.0-only
// Board command outcomes share one report; App-owned assignments reread through custody.
import type { ProjectRow } from '@launchastro/ui';
import type { CallResult, OperationsClient } from '../../operations/client.ts';
import { settle, type Settlement } from '../../records/use-command.ts';
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

/** Settled or not, the board re-reads: a refusal redraws the stored truth, and is said as well. */
export function sender(
  onSettled: (refused: string | null) => void,
  reload: () => void,
): (sent: Promise<CallResult<unknown>>) => void {
  const settleOne = async (sent: Promise<CallResult<unknown>>): Promise<void> => {
    try {
      onSettled(refusalOf(settle(await sent)));
    } catch {
      onSettled(refusalOf({ kind: 'unknown', because: 'No answer came back.' }));
    }
    reload();
  };
  return (sent) => {
    void settleOne(sent);
  };
}

/** What the board says about a write: nothing when it landed, else the server's words. */
function refusalOf(settled: Settlement): string | null {
  if (settled.kind === 'ok') return null;
  if (settled.kind === 'unknown') {
    return `The change may not have been stored: ${settled.because} Check the row before trying again.`;
  }
  return `The change was not made: ${settled.because}`;
}
