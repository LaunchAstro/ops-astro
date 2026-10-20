// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: the board screen's one stream per tab, on T2f's content-free
// channel. Frames are `resync` and `closed`, and neither carries a task,
// client or item identifier: the tab refetches its board and inbox through
// their own reads, which apply the grant when they are read.
//
// One rule (ORCH46, REVB1ENDFIXAPID): the stream holds one digest, of what
// the reader's own reads show them now (the tasks they read and their
// activity, and their inbox), taken for the person the bearer resolves to.
// Any signal for the business, and the recheck, run the rule once for every
// signal heard while it runs: digest that person's reads, ask the join again,
// and say `resync` when the digest moved since the tab was last told. A
// change the reader cannot read moves nothing they are shown and says
// nothing; `closed` the first time the join is refused.
//
// When the bearer resolves to another person, the old topic is dropped and
// the new person's is heard, and nothing is said until the stream's own
// recheck tells the tab `resync`, so no signal of the old person's times a
// frame for the new one. The join is asked after each digest and before its
// frame, so a digest taken for a person the bearer has left is never said.
//
// C71 (CS-7.42): a conversation heard is not digested. Membership, the join, then membership
// again: a member alone is told `conversation` (naming none), so the Team tab's chip re-reads
// `chat.conversations`; anyone else, one removed mid-join included, is told nothing. A
// reconnect (`resync`) may have lost a signal, so it asks of any conversation, says it once.
//
// A join the sign-in provider could not answer (its key set unreachable) is no
// answer: nothing is said or closed, and what that run owed waits for the next.
//
// Stopping the stream (the tab leaving, or the topics closing) ends its
// recheck, and the stream lets go only once no question it asked is in
// flight, so none reaches a pool that closes after it.

import type { SSEStreamingApi } from 'hono/streaming';
import { UNANSWERED, type BoardSignal, type LiveTopics, type Unanswered } from './live.ts';

export interface BoardQuestions {
  /** The person the bearer resolves to now, if they may still hold the stream; no answer from the provider. */
  readonly joinedAs: () => Promise<string | undefined | Unanswered>;
  /** A digest of the tasks `personId` reads now and their activity; undefined when refused. */
  readonly reach: (personId: string) => Promise<string | undefined>;
  /** A digest of what `inbox.read` shows `personId` now; undefined when refused. */
  readonly shown: (personId: string) => Promise<string | undefined>;
  /**
   * Called as each run starts, `heard` when a signal woke it rather than the
   * stream's own check: the questions of one run may share one check of the bearer.
   */
  readonly newRun?: (heard: boolean) => void;
  /** Whether `personId` is a current member of any of these (`any`: of any) now; absent, never. */
  readonly hears?: (
    personId: string,
    conversationIds: readonly string[] | 'any',
  ) => Promise<boolean>;
}

/** The stream, or the board topic's share of C4's one stream. */
type BoardStream = Pick<SSEStreamingApi, 'writeSSE' | 'abort' | 'aborted' | 'onAbort'>;

const noop = (): void => {};

/** The person whose reads the stream digests, and the digest the tab was last told. */
interface Bound {
  personId: string;
  seen: string | undefined;
  /** Rebound and not yet told: only the recheck's `resync` tells the tab. */
  owed: boolean;
  unsubscribe: () => void;
  /** The rule being run; the stream lets go only once it is done. */
  asking: Promise<void>;
}

export async function followBoard(
  stream: BoardStream,
  topics: LiveTopics,
  on: { readonly businessId: string; readonly personId: string; readonly recheckMs: number },
  ask: BoardQuestions,
): Promise<void> {
  // A stream that ended before this ran (the tab left while the route awaited)
  // never calls a listener added now, so its end is taken as already here.
  const ended = new Promise<void>((resolve) => {
    if (stream.aborted) resolve();
    else stream.onAbort(resolve);
  });
  let finished = noop;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = async (): Promise<void> => {
    stream.abort();
    await done;
  };
  const bound: Bound = {
    personId: on.personId,
    seen: undefined,
    owed: false,
    unsubscribe: () => {},
    asking: Promise.resolve(),
  };
  const bind = (personId: string): void => {
    bound.unsubscribe();
    bound.personId = personId;
    bound.unsubscribe = topics.subscribeBoard(on.businessId, personId, hear, stop);
  };
  const hear = batch(stream, ask, bound, bind);
  bind(on.personId);
  const timer = setInterval(() => hear('check'), on.recheckMs);
  try {
    // Taken after subscribing and before the resync the tab reads from, so a
    // change between the two is either in the tab's read or said after it.
    if (!stream.aborted) hear('check');
    await ended;
  } finally {
    clearInterval(timer);
    await bound.asking;
    bound.unsubscribe();
    finished();
  }
}

/** The rule run once for every signal heard while it runs; `check` is the stream's own. */
function batch(
  stream: BoardStream,
  ask: BoardQuestions,
  bound: Bound,
  bind: (personId: string) => void,
): (signal: BoardSignal | 'check') => void {
  const pending: Pending = { heard: false, check: false, any: false, chats: new Set() };
  const drain = async (): Promise<void> => {
    while (!stream.aborted && (pending.heard || pending.check || pending.chats.size > 0)) {
      const { heard, check, chats } = take(pending);
      ask.newRun?.(heard);
      // eslint-disable-next-line no-await-in-loop -- one run before the next.
      const joined = heard || check ? await rule(stream, ask, bound, bind, check) : 'same';
      if (joined === 'closed') return;
      if (joined === 'unanswered') return owe(pending, heard, check, chats);
      // A rebind the recheck found is told by that recheck, from the new person's reads.
      if (joined === 'rebound' && check) pending.check = true;
      const toTell = chats === 'any' || chats.length > 0;
      // eslint-disable-next-line no-await-in-loop -- one run before the next.
      const said = toTell ? await told(stream, ask, bound, bind, chats) : 'same';
      if (said === 'closed') return;
      if (said === 'unanswered') return owe(pending, false, false, chats);
    }
  };
  let queued = false;
  const wake = (): void => {
    if (queued) return;
    queued = true;
    bound.asking = bound.asking
      .then(async () => {
        queued = false;
        return await drain();
      })
      .catch(() => stream.abort());
  };
  return (signal) => {
    if (signal === 'check') pending.check = true;
    else if (signal.kind === 'conversation') pending.chats.add(signal.conversationId);
    else {
      pending.heard = true;
      // A reconnect may have lost a conversation's signal: ask of every one.
      pending.any ||= signal.kind === 'resync';
    }
    wake();
  };
}

/** What the stream has heard and not yet run the rule for. */
interface Pending {
  heard: boolean;
  check: boolean;
  any: boolean;
  readonly chats: Set<string>;
}

/** What a run answers, taken from `pending` and cleared there. */
function take(pending: Pending) {
  const { heard, check } = pending;
  const chats: readonly string[] | 'any' = pending.any ? 'any' : [...pending.chats];
  pending.heard = pending.check = pending.any = false;
  pending.chats.clear();
  return { heard, check, chats };
}

/** A run the provider could not answer: its signals wait for the next signal or check. */
function owe(
  pending: Pending,
  heard: boolean,
  check: boolean,
  chats: readonly string[] | 'any',
): void {
  pending.heard ||= heard;
  pending.check ||= check;
  if (chats === 'any') pending.any = true;
  else for (const chat of chats) pending.chats.add(chat);
}

/** A frame, unless the stream ended while a question before it was asked. */
async function send(stream: BoardStream, event: string): Promise<void> {
  if (!stream.aborted) await stream.writeSSE({ event, data: '' });
}

/**
 * The one rule: the bound person's reads digested, the join asked again, and
 * `resync` when the bearer is still that person and the digest moved.
 */
async function rule(
  stream: BoardStream,
  ask: BoardQuestions,
  bound: Bound,
  bind: (personId: string) => void,
  check: boolean,
): Promise<Joined> {
  const tasks = await ask.reach(bound.personId);
  const inbox = await ask.shown(bound.personId);
  const joined = await rejoin(stream, ask, bound, bind);
  // A read refused because the bearer moved during it is asked again by the next run.
  if (joined !== 'same' || tasks === undefined || inbox === undefined) return joined;
  if (bound.owed && !check) return joined;
  bound.owed = false;
  const seen = `${tasks} ${inbox}`;
  if (seen === bound.seen) return joined;
  bound.seen = seen;
  await send(stream, 'resync');
  return joined;
}

/**
 * `conversation` said to a current member whose bearer is still that person, already told;
 * asked again after the join, so one removed while it was asked is told nothing.
 */
async function told(
  stream: BoardStream,
  ask: BoardQuestions,
  bound: Bound,
  bind: (personId: string) => void,
  chats: readonly string[] | 'any',
): Promise<Joined> {
  const hears = async (): Promise<boolean> => (await ask.hears?.(bound.personId, chats)) ?? false;
  const member = await hears();
  const joined = await rejoin(stream, ask, bound, bind);
  if (joined === 'same' && member && !bound.owed && (await hears())) {
    await send(stream, 'conversation');
  }
  return joined;
}

/** What asking the join again found. */
type Joined = 'closed' | 'rebound' | 'same' | 'unanswered';

/**
 * The join asked again: `closed` (said, and the stream ended) when it is
 * refused; `rebound` when the bearer now resolves to another person, whose
 * topic replaces the previous one's; `unanswered` when the provider could not
 * be asked; `same` otherwise.
 */
async function rejoin(
  stream: BoardStream,
  ask: BoardQuestions,
  bound: Bound,
  bind: (personId: string) => void,
): Promise<Joined> {
  const personId = await ask.joinedAs();
  if (personId === UNANSWERED) return 'unanswered';
  if (personId === undefined) {
    await send(stream, 'closed');
    stream.abort();
    return 'closed';
  }
  if (personId === bound.personId) return 'same';
  bind(personId);
  bound.seen = undefined;
  bound.owed = true;
  return 'rebound';
}
