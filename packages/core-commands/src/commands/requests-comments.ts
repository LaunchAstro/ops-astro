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
