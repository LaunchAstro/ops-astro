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
// replayed edit proposal stays bound to it, and a start keeps the page it
// carried and what the tab was on when it went, so a replay restores its own
// conversation's context and nobody else's (`started.ts`). Held in the view for
// its life only, never in storage.

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
export interface Asked<C = unknown> {
  readonly command: 'conversation.start' | 'conversation.message';
  readonly question: string;
  readonly request: Readonly<Record<string, unknown>>;
  /** The chat's task as read before the question was first sent; none off a task or unread. */
  readonly baseline?: ReadAt | null;
  /** What the tab was on at the first send, kept beside the request (`first-question.ts`). */
  readonly context?: C;
}

export type Kept<C = unknown> = Asked<C> & { readonly operationId: string };

export interface Resends<C = unknown> {
  /** Sends `asked` for tab `key`, as the kept attempt when it is a resend. */
  send<T>(
    key: string,
    asked: Asked<C>,
    write: (
      request: Asked['request'],
      operationId: string,
      sending: Kept<C>,
    ) => Promise<CallResult<T>>,
  ): Promise<CallResult<T>>;
  /** Whether tab `key` keeps a lost `command` for this question as typed. */
  holds(key: string, command: Asked['command'], question: string): boolean;
  /** Whether a lost start tab `key` keeps was sent with a context `which` picks. */
  carries(key: string, which: (context: C) => boolean): boolean;
  /**
   * Tab `from`'s lost questions moved to tab `into`, which it folded into: a
   * resend there replays its own identity. Where both keep the same question,
   * both stay, oldest first, and a resend replays the oldest still kept.
   */
  fold(from: string, into: string): void;
}

/** How a tab keeps a lost question: by command and question as typed. */
const lostAs = (asked: Pick<Asked, 'command' | 'question'>): string =>
  `${asked.command}\n${asked.question}`;

/** Two tabs' lost questions as one, each question's attempts oldest first. */
function joined<K extends { readonly operationId: string }>(
  target: Map<string, K[]>,
  moving: Map<string, K[]>,
  born: ReadonlyMap<string, number>,
): Map<string, K[]> {
  const order = (one: K): number => born.get(one.operationId) ?? 0;
  for (const [which, list] of moving) {
    target.set(
      which,
      [...(target.get(which) ?? []), ...list].toSorted((one, other) => order(one) - order(other)),
    );
  }
  return target;
}

/**
 * Each tab's lost questions, and where each folded tab went: a send still out
 * when its tab folds settles in the tab it folded into (S1917-2).
 */
function homes<K>() {
  const kept = new Map<string, Map<string, K[]>>();
  const moved = new Map<string, string>();
  const home = (key: string): string => {
    const into = moved.get(key);
    return into === undefined ? key : home(into);
  };
  const lostIn = (key: string): Map<string, K[]> => {
    const lost = kept.get(home(key)) ?? new Map<string, K[]>();
    kept.set(home(key), lost);
    return lost;
  };
  return { kept, moved, lostIn };
}

export function resends<C = unknown>(): Resends<C> {
  const { kept, moved, lostIn } = homes<Kept<C>>();
  const ended = new Set<string>();
  // The order each attempt was kept in: a fold keeps both tabs' attempts, oldest first.
  const born = new Map<string, number>();
  const all = (key: string): Kept<C>[] => [...(kept.get(key)?.values() ?? [])].flat();
  return {
    holds: (key, command, question) =>
      (kept.get(key)?.get(lostAs({ command, question }))?.length ?? 0) > 0,
    carries: (key, which) =>
      all(key).some(
        (one) =>
          one.command === 'conversation.start' && one.context !== undefined && which(one.context),
      ),
    fold(from, into) {
      moved.set(from, into);
      const moving = kept.get(from);
      if (moving === undefined) return;
      kept.set(into, joined(kept.get(into) ?? new Map(), moving, born));
      kept.delete(from);
    },
    async send(key, asked, write) {
      const which = lostAs(asked);
      const sending = lostIn(key).get(which)?.[0] ?? {
        ...asked,
        operationId: crypto.randomUUID(),
      };
      const result = await write(sending.request, sending.operationId, sending);
      // Each completion owns its own identity: an older send settling late
      // never clears, or takes the place of, another send's kept one.
      const lost = lostIn(key);
      const now = lost.get(which) ?? [];
      if (!isUnavailable(result) && !isRefusal(result)) {
        ended.add(sending.operationId);
        lost.set(
          which,
          now.filter((one) => one.operationId !== sending.operationId),
        );
      } else if (isUnavailable(result) && now.length === 0 && !ended.has(sending.operationId)) {
        born.set(sending.operationId, born.size);
        lost.set(which, [sending]);
      }
      return result;
    },
  };
}
