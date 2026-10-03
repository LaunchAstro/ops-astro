// SPDX-License-Identifier: AGPL-3.0-only
//
// The comment shapes of `CommandRequest` (MP-4-5), beside it in `requests.ts`,
// which joins them to its one union with its own targeted envelope. A comment
// names what it says and to whom; an edit or a deletion names the comment.

export type CommentRequest<Targeted> =
  | ({
      readonly command: 'task.comment';
      readonly body: string;
      /** `internal` or `client`. Two fields, because who sees it and what it is
       * are two questions (`core-records/src/tasks/comments.ts`). */
      readonly audience: string;
      /** `note`, `client` or `system`. A person writing a comment writes a note. */
      readonly commentType?: string;
      /** The top-level message on this task a reply sits under (R42). */
      readonly parentId?: string | null;
      /** The people the comment names, by person id. */
      readonly mentions?: unknown;
    } & Targeted)
  | ({
      readonly command: 'task.edit_comment';
      readonly commentId: string;
      readonly body: string;
    } & Targeted)
  | ({ readonly command: 'task.delete_comment'; readonly commentId: string } & Targeted);

/** Team conversations (C71-D): a direct message names its teammate; the marker, its conversation. */
export type ChatRequest<E> =
  | ({
      readonly command: 'chat.send_direct';
      readonly teammateId: string;
      readonly body: string;
      /** CS-7.42: the people the message names, checked by value. */
      readonly mentions?: unknown;
    } & E)
  | ({
      readonly command: 'chat.mark_read';
      readonly conversationId: string;
      /** The newest message's time the reader saw, as ISO text. */
      readonly upTo: string;
    } & E)
  // Group conversations (C71-G): the lists and the name are checked by value.
  | ({
      readonly command: 'chat.start_group';
      readonly name: unknown;
      readonly members: unknown;
    } & E)
  | ({
      readonly command: 'chat.send_group';
      readonly conversationId: string;
      readonly body: string;
      readonly mentions?: unknown;
    } & E)
  | ({
      readonly command: 'chat.rename_group';
      readonly conversationId: string;
      readonly name: unknown;
    } & E)
  | ({
      readonly command: 'chat.change_members';
      readonly conversationId: string;
      readonly add?: unknown;
      readonly remove?: unknown;
    } & E)
  | ({ readonly command: 'chat.leave'; readonly conversationId: string } & E);
