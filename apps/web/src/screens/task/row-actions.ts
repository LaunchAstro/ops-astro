// SPDX-License-Identifier: AGPL-3.0-only
//
// Editing and deleting a row of the task's conversation (`Thread.tsx`): each
// goes out through its own command against the task, and the task is read
// again on any answer but a plain refusal, so what is drawn is what the server
// has. A lost answer is not retried as the same attempt: sending the same
// words again, or deleting what is already gone, changes nothing, and the
// reread shows which happened.
//
// **An edit keeps its words until it is stored.** The edit is held above the
// read with the words typed, so a reread that remounts the thread, a stale
// refusal's among them, still finds the box open with them and the server's
// reason under it. Only a stored edit closes the box.

import type { OperationsClient } from '../../operations/client.ts';
import { useCommand, type Settlement } from '../../records/use-command.ts';
import type { RowActions, RowEdit } from './Thread.tsx';

/** What the row commands need from the conversation that draws them. */
export interface RowWrites {
  readonly client: OperationsClient;
  readonly recordId: string;
  readonly revision: number;
  readonly onPosted: () => void;
  /** The edit open on a row, held above the read so a reread keeps it. */
  readonly editing: RowEdit | null;
  readonly onEditing: (next: RowEdit | null) => void;
}

/** Any answer but a plain refusal may have changed the task, so it is read again. */
const rereads = (settlement: Settlement): boolean =>
  settlement.kind === 'ok' || settlement.kind === 'unknown' || settlement.kind === 'stale';

export function useRowActions(
  props: RowWrites,
  onReply: (commentId: string) => void,
): { readonly actions: RowActions; readonly because: string | null } {
  const command = useCommand();
  const send = (
    name: 'task.edit_comment' | 'task.delete_comment',
    operands: object,
    then?: (settlement: Settlement) => void,
  ): void => {
    command.run(
      () =>
        props.client.mutate(
          name,
          { recordId: props.recordId, ...operands },
          { expectedRevision: props.revision },
        ),
      (settlement) => {
        then?.(settlement);
        if (rereads(settlement)) props.onPosted();
      },
    );
  };
  return {
    // The held reason outlives the reread that the command's own does not.
    because: command.because ?? props.editing?.because ?? null,
    actions: {
      busy: command.busy,
      editing: props.editing,
      onEditing: props.onEditing,
      onReply,
      onEdit: (commentId, body) => {
        props.onEditing({ commentId, body, because: null });
        send('task.edit_comment', { commentId, body }, (settlement) => {
          props.onEditing(
            settlement.kind === 'ok' ? null : { commentId, body, because: settlement.because },
          );
        });
      },
      onDelete: (commentId) => {
        send('task.delete_comment', { commentId });
      },
    },
  };
}
