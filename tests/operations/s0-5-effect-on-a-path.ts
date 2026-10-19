// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's effect proof: the kinds an EXACT command declares that its one positive fixture cannot
// reach, each proved where it is written. Moved whole from `s0-5-effect-metadata.test.ts` for the
// line cap.

const REPLY_SNAPSHOT = ['conversation_reply_snapshots', 'conversation_reply_targets'];

/**
 * An EXACT kind its fixture misses, proved where written: money-paths, the reopened-step end, and
 * a reply's snapshot, kept only when the exchange answers in a chat on no task (#1666,
 * `tests/api/a-chat-on-no-task-keeps-the-tasks-it-created-with-each-reply.test.ts`).
 */
export const ON_A_PATH: Readonly<Record<string, readonly string[]>> = {
  'run.top_up': ['attempts'],
  'run.end_at_budget_stop': ['attempts'],
  'conversation.start': REPLY_SNAPSHOT,
  'conversation.message': REPLY_SNAPSHOT,
};
