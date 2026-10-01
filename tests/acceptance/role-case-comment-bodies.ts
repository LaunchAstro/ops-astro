// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive body for MP-4-5's author-only commands, `task.edit_comment`
// and `task.delete_comment`, beside the rest of the recipes in
// `role-case-positive-body.ts`: only a comment's author changes it, so the body
// names a comment the calling author wrote.

import { randomUUID } from 'node:crypto';

/** The part of the recipes' context this needs; `BodyContext` is one. */
interface CommentContext {
  freshTask(title: string): Promise<{ readonly id: string; readonly revision: number }>;
  ownComment?(author?: unknown): Promise<{
    readonly id: string;
    readonly revision: number;
    readonly commentId: string;
  }>;
}

/**
 * An author-only comment change (MP-4-5): the author's own comment when the
 * world can write one, else a well-formed body the authority check refuses.
 */
export async function commentChangeBody(
  context: CommentContext,
  name: string,
  author: unknown,
): Promise<Record<string, unknown>> {
  const words = name === 'task.edit_comment' ? { body: 'changed' } : {};
  if (context.ownComment === undefined) {
    const task = await context.freshTask(`a task for ${name}`);
    return {
      recordId: task.id,
      expectedRevision: task.revision,
      commentId: randomUUID(),
      ...words,
    };
  }
  const own = await context.ownComment(author);
  return { recordId: own.id, expectedRevision: own.revision, commentId: own.commentId, ...words };
}
