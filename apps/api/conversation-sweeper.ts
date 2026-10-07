// SPDX-License-Identifier: AGPL-3.0-only
//
// R7: the idle sweep (AW-03, `sweepConversations`) on an interval over every
// business the deployment serves, as system work beside the mail worker and
// the trace export. Nothing on the wire reaches it.
//
// A round sweeps each business once, in turn, so no two passes over one
// business run at once, and a round still running when the next is due is
// skipped, not stacked. The first round runs at start, so a deployment that
// restarts more often than the interval still sweeps. A business whose pass
// throws is that business's failure and the round goes on to the next; a
// round that cannot read its businesses is logged and the next tick tries
// again. `stop` starts no round and no business after it, and resolves once a
// pass in flight has ended, so the pool outlives every pass.
//
// Each failure a pass reports is handed to `raise` once per business and
// cause: a wrap-up or a purge that could not be written (a conversation held
// by another transaction past the lock timeout, or a write that threw), a
// window that cannot be read, or the pass itself throwing. A cause stays open
// while passes keep reporting it and is raised again only after a pass
// without it, so a failure that lasts is not raised every hour. A failure
// names its business, its cause and the conversations it concerns by id:
// never a title, a subject, a body or an error's text. A conversation held by
// the retention rule (open work, a window not yet passed) is the rule
// working, not a failure.
//
// The inbox item is not raised here. Every inbox item is about a task
// (`inbox_items.subject_record_id`, 0042) and a sweep failure has none, so the
// default `raise` logs the cause alone until INB-1 gives the sweep's failure a
// subject and an audience.

import {
  sweepConversations,
  type SweepReport,
  type SweepRequest,
} from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

/** Hourly: quiet is a day and the window at least a week, so an hour late changes nothing. */
export const CONVERSATION_SWEEP_EVERY_MS = 3_600_000;

export type SweepFailureCause = 'wrap_up' | 'purge' | 'window_unreadable' | 'pass';

export interface SweepFailure {
  readonly businessId: string;
  readonly cause: SweepFailureCause;
  /** The conversations it concerns, by id only; none for a window or a pass. */
  readonly conversationIds: readonly string[];
}

export interface SweeperOptions {
  /** The businesses to sweep, read at the start of every round. */
  readonly businesses: () => Promise<readonly string[]>;
  /** The code revision the pass runs, recorded on each wrap-up. */
  readonly codeRevision: string;
  /** Told of each failure once while it lasts; `logSweepFailure` if absent. */
  readonly raise?: (failure: SweepFailure) => Promise<void> | void;
  /** The pass over one business: `sweepConversations`, unless a case wraps it. */
  readonly sweep?: (database: Database, request: SweepRequest) => Promise<SweepReport>;
  readonly lockTimeoutMs?: number;
}

const WORDS: Readonly<Record<SweepFailureCause, string>> = {
  wrap_up: 'a wrap-up could not be written',
  purge: 'a purge could not be written',
  window_unreadable: 'the conversation window could not be read, so nothing was purged',
  pass: 'the pass failed',
};

/** The default raise: the cause alone, never the business, a conversation or an error's text. */
export function logSweepFailure(failure: SweepFailure): void {
  console.error(`conversation sweep: ${WORDS[failure.cause]} in one business`);
}

/** What one pass reported, as failures by cause. */
function failuresOf(businessId: string, report: SweepReport): SweepFailure[] {
  const failures: SweepFailure[] = [];
  for (const stage of ['wrap_up', 'purge'] as const) {
    const conversationIds = report.failed
      .filter((failed) => failed.stage === stage)
      .map((failed) => failed.conversationId);
    if (conversationIds.length > 0) failures.push({ businessId, cause: stage, conversationIds });
  }
  if (report.windowUnreadable) {
    failures.push({ businessId, cause: 'window_unreadable', conversationIds: [] });
  }
  return failures;
}

/**
 * One round's work, over `options.businesses()`, holding which causes are
 * open in each business from one round to the next. `stopping`, once aborted,
 * starts no further business.
 */
export function sweepRound(
  database: Database,
  options: SweeperOptions,
  stopping?: AbortSignal,
): () => Promise<void> {
  const open = new Map<string, ReadonlySet<SweepFailureCause>>();
  const raise = options.raise ?? logSweepFailure;
  const sweep = options.sweep ?? sweepConversations;
  const hand = async (failure: SweepFailure): Promise<void> => {
    try {
      await raise(failure);
    } catch {
      console.error('conversation sweep: a failure could not be raised');
    }
  };
  const one = async (businessId: string): Promise<void> => {
    const before = open.get(businessId) ?? new Set<SweepFailureCause>();
    let failures: SweepFailure[];
    let now: Set<SweepFailureCause>;
    try {
      const report = await sweep(database, {
        businessId,
        codeRevision: options.codeRevision,
        ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      });
      failures = failuresOf(businessId, report);
      now = new Set(failures.map((failure) => failure.cause));
    } catch {
      // What else failed is unknown this round, so what was open stays open.
      failures = [{ businessId, cause: 'pass', conversationIds: [] }];
      now = new Set([...before, 'pass']);
    }
    open.set(businessId, now);
    for (const failure of failures) {
      // oxlint-disable-next-line no-await-in-loop -- one failure after another
      if (!before.has(failure.cause)) await hand(failure);
    }
  };
  return async () => {
    for (const businessId of await options.businesses()) {
      if (stopping?.aborted === true) return;
      // oxlint-disable-next-line no-await-in-loop -- one business's pass before the next's
      await one(businessId);
    }
  };
}

/** The round at start and then every `everyMs`, never two at once, until `stop`. */
export function startConversationSweeper(
  database: Database,
  options: SweeperOptions & { readonly everyMs?: number },
): { readonly stop: () => Promise<void> } {
  const stopping = new AbortController();
  const round = sweepRound(database, options, stopping.signal);
  let running: Promise<void> | undefined;
  const once = (): void => {
    if (stopping.signal.aborted || running !== undefined) return;
    running = round()
      .catch(() => {
        console.error('conversation sweep: the round could not read its businesses');
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(once, options.everyMs ?? CONVERSATION_SWEEP_EVERY_MS);
  timer.unref();
  once();
  return {
    stop: async () => {
      stopping.abort();
      clearInterval(timer);
      await running;
    },
  };
}
