// SPDX-License-Identifier: AGPL-3.0-only
//
// A tab's question whose answer was lost: the server may have committed it,
// so its identity and its complete request are kept, and resending the same
// question presents exactly that request again. The server's register then
// replays the first attempt rather than starting a second conversation or
// posting a second message. A tab keeps each lost question on its own, by
// command and question as typed, so a second lost question keeps its identity
// beside the first. Only a success of that same identity proves what the
// first attempt did, so only that clears it, and for good: a replay of it
// that loses its answer later never brings it back. A refusal of a replay may
// be today's rights answering a committed attempt, and the identity stays. A
// send whose own first answer was a refusal was never lost and keeps nothing.
// Each attempt carries the task revision its question first read, so a
// replayed edit proposal stays bound to it. Held in the view for its life
// only, never in storage.

import { isRefusal, isUnavailable, type CallResult } from '../operations/client.ts';

/**
 * The task revision a question read before it was first sent, as
 * `proposals.ts` keeps it; spelled here so this module needs nothing of the
 * drawer's (the API suites import it).
 */
export interface ReadAt {
  readonly taskId: string;
  readonly revision: number;
}

/** What a send asks: its command, the question as typed, the complete request and what it read. */
export interface Asked {
  readonly command: 'conversation.start' | 'conversation.message';
  readonly question: string;
  readonly request: Readonly<Record<string, unknown>>;
  /** The chat's task as read before the question was first sent; none off a task or unread. */
  readonly baseline?: ReadAt | null;
}

export type Kept = Asked & { readonly operationId: string };

export interface Resends {
  /** Sends `asked` for tab `key`, as the kept attempt when it is a resend. */
  send<T>(
    key: string,
    asked: Asked,
    write: (
      request: Asked['request'],
      operationId: string,
      sending: Kept,
    ) => Promise<CallResult<T>>,
  ): Promise<CallResult<T>>;
}

export function resends(): Resends {
  const kept = new Map<string, Map<string, Kept>>();
  const ended = new Set<string>();
  return {
    async send(key, asked, write) {
      const lost = kept.get(key) ?? new Map<string, Kept>();
      kept.set(key, lost);
      const which = `${asked.command}\n${asked.question}`;
      const sending = lost.get(which) ?? { ...asked, operationId: crypto.randomUUID() };
      const result = await write(sending.request, sending.operationId, sending);
      // Each completion owns its own identity: an older send settling late
      // never clears, or takes the place of, another send's kept one.
      const now = lost.get(which);
      if (!isUnavailable(result) && !isRefusal(result)) {
        ended.add(sending.operationId);
        if (now?.operationId === sending.operationId) lost.delete(which);
      } else if (isUnavailable(result) && now === undefined && !ended.has(sending.operationId)) {
        lost.set(which, sending);
      }
      return result;
    },
  };
}
