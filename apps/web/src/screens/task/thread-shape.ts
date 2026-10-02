// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of one tab's thread (MP-4-5, R42), worked out from the flat list
// the read sends: each message with its replies under it, a reply on the
// third message as present as one on the first, and a deleted message's
// replies kept together under the message they answered.

import type { InternalCommentView } from '../../../../../packages/core-wire/src/index.ts';

export interface Message {
  readonly id: string;
  /** Null when the message was deleted and only its replies remain. */
  readonly comment: InternalCommentView | null;
  readonly replies: readonly InternalCommentView[];
  readonly at: number;
}

const timeOf = (comment: InternalCommentView): number => Date.parse(comment.posted_at);

/** The message a reply answers; null on a message, and on a read that predates replies. */
export const parentOf = (comment: InternalCommentView): string | null => comment.parent ?? null;

/** The messages, oldest first, each holding its replies, oldest first. */
export function threadOf(comments: readonly InternalCommentView[]): readonly Message[] {
  const ordered = comments.toSorted((a, b) => timeOf(a) - timeOf(b));
  const tops = ordered.filter((comment) => parentOf(comment) === null);
  const known = new Set(tops.map((comment) => comment.id));
  const repliesTo = (id: string): readonly InternalCommentView[] =>
    ordered.filter((comment) => parentOf(comment) === id);
  const orphans = [
    ...new Set(
      ordered.flatMap((comment) => {
        const parent = parentOf(comment);
        return parent === null || known.has(parent) ? [] : [parent];
      }),
    ),
  ];
  return [
    ...tops.map((comment) => ({
      id: comment.id,
      comment,
      replies: repliesTo(comment.id),
      at: timeOf(comment),
    })),
    ...orphans.map((id) => {
      const replies = repliesTo(id);
      return { id, comment: null, replies, at: replies[0] === undefined ? 0 : timeOf(replies[0]) };
    }),
  ].toSorted((a, b) => a.at - b.at);
}
