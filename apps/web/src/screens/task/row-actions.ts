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
//
// **An edit names what it was typed against.** It sends the row's `edited_at`
// from when the box opened, so an edit made meanwhile elsewhere (another tab)
// is refused stale instead of silently replaced.

import type { InternalCommentView } from '../../../../../packages/core-wire/src/index.ts';
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

/**
 * The `edited_at` an edit is sent against: the one its box opened on, or, once
 * a refusal has been answered and the row read again, the row's as it now reads.
 */
const againstOf = (held: RowEdit | null, comment: InternalCommentView): string | null =>
  held?.commentId === comment.id && held.because === null ? held.editedAt : comment.edited_at;

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
      onEdit: (comment, body) => {
        const commentId = comment.id;
        const editedAt = againstOf(props.editing, comment);
        props.onEditing({ commentId, body, editedAt, because: null });
        send('task.edit_comment', { commentId, body, expectedEditedAt: editedAt }, (settlement) => {
          props.onEditing(
            settlement.kind === 'ok'
              ? null
              : { commentId, body, editedAt, because: settlement.because },
          );
        });
      },
      onDelete: (commentId) => {
        send('task.delete_comment', { commentId });
      },
    },
  };
}
