// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker: what makes inbox mail go out. Two passes over one
// business, each run as system work under the business's worker (an active
// worker actor, the AW-01 J rule: system writes run under a worker, never a
// person's grant):
//
// - `at_once`, often: `emailAtOnce` for each due decision and incident, and
//   any other item whose person chose instant for its category.
// - `daily`, on the daily tick: `emailDailyBatch` for each person with an
//   item waiting for the day's email.
//
// An item is due while it is open, owed, unseen, and its last email
// observation allows a send (none yet, or a failure that proves nothing
// went). The worker only chooses whom to try. Every refusal is the send's
// own, under its locks, so a second worker racing this one, under the same
// worker or another, sends nothing twice: the first's `asked` is what the
// second reads (`checkItem`, `windowSpent`). The ceiling and each client's
// week are the send path's too; a pass at the ceiling stops, and the next
// pass carries on. So is the worker's standing: each send holds the worker
// actor and finds it active before custody is asked, so a worker deactivated
// mid-pass sends nothing further.
//
// The daily tick runs every hour of the batch window, not once a day: each
// person's day is their own window, read from their last batch, so a tick
// exactly a day apart would miss a day by the previous send's own delay.

import {
  isUuid,
  toldAtOnce,
  type BusinessId,
  type Database,
  type InboxReason,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import { DAY_MS, NOTHING_SENT } from './email-class.ts';
import { emailAtOnce, emailDailyBatch, type EmailTiming } from './email-timing.ts';

export type DeliveryPass =
  | { readonly ok: true; readonly emails: number }
  | { readonly ok: false; readonly code: 'WORKER_REQUIRED' };

/** Items that may still be emailed: open, owed, unseen, and no email that may have gone. */
const DUE = `select i.id, i.recipient_person_id as recipient, i.reason
   from public.inbox_items i
  where i.business_id = $1 and i.work_state = 'open' and i.owed
    and not exists (select 1 from public.inbox_attention s
                     where s.business_id = i.business_id and s.item_id = i.id)
    and coalesce((select a.state = 'failed' and a.evidence = any($2::text[])
                    from public.inbox_delivery_attempts a
                   where a.business_id = i.business_id and a.item_id = i.id
                     and a.channel = 'email'
                   order by a.observed_seq desc limit 1), true)
  order by i.raised_at, i.id`;

/**
 * The worker actor, held `for share` and active: a deactivation in flight is waited on and then
 * read, and one that comes later waits for this transaction's end.
 */
async function activeWorker(tx: TenantQuery, actorId: string): Promise<boolean> {
  if (!isUuid(actorId)) return false;
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and id = $2 and kind = 'worker' and active for share`,
    [tx.businessId, actorId],
  );
  return rows.length === 1;
}

/** Whom this pass tries: the due items told at once, or the people waiting for the day's email. */
async function whomToTry(
  tx: TenantQuery,
  timing: EmailTiming,
  kind: 'at_once' | 'daily',
): Promise<string[]> {
  const due = await tx.query<{
    readonly id: string;
    readonly recipient: string;
    readonly reason: InboxReason;
  }>(DUE, [tx.businessId, [...NOTHING_SENT]]);
  if (kind === 'daily') {
    return [...new Set(due.filter((row) => !toldAtOnce(row.reason)).map((row) => row.recipient))];
  }
  const now: string[] = [];
  for (const row of due) {
    if (
      toldAtOnce(row.reason) ||
      // oxlint-disable-next-line no-await-in-loop
      (await timing.preferences.choice(tx, row.recipient, row.reason)) === 'instant'
    ) {
      now.push(row.id);
    }
  }
  return now;
}

/**
 * One pass over one business; how many emails it handed to custody. `stop`, once aborted, starts
 * no further send: it is checked between sends, and a send already asked runs to its end. The
 * worker's standing is checked again in each send's own transaction, before custody is asked: a
 * worker deactivated mid-pass sends nothing further, and the pass answers `WORKER_REQUIRED`.
 */
export async function deliverDue(
  database: Database,
  businessId: BusinessId,
  workerActorId: string,
  timing: EmailTiming,
  kind: 'at_once' | 'daily',
  stop?: AbortSignal,
): Promise<DeliveryPass> {
  const targets = await database.withBusiness(businessId, async (tx) =>
    (await activeWorker(tx, workerActorId)) ? await whomToTry(tx, timing, kind) : undefined,
  );
  if (targets === undefined) return { ok: false, code: 'WORKER_REQUIRED' };
  const asWorker: EmailTiming = {
    ...timing,
    standing: async (tx) => await activeWorker(tx, workerActorId),
  };
  let emails = 0;
  for (const target of targets) {
    if (stop?.aborted === true) break;
    // One send at a time: each is its own transactions and custody call.
    const sent =
      kind === 'at_once'
        ? // oxlint-disable-next-line no-await-in-loop
          await emailAtOnce(database, businessId, target, asWorker)
        : // oxlint-disable-next-line no-await-in-loop
          await emailDailyBatch(database, businessId, target, asWorker);
    if (!sent.ok && sent.code === 'WORKER_REQUIRED') return { ok: false, code: 'WORKER_REQUIRED' };
    if (sent.ok || sent.code === 'EMAIL_FAILED') emails += 1;
    else if (sent.code === 'EMAIL_AT_CEILING') break;
  }
  return { ok: true, emails };
}

/** One business the worker serves, and the worker actor it runs as there. */
export interface MailTarget {
  readonly businessId: BusinessId;
  readonly workerActorId: string;
}

/** How often each pass runs; the daily tick is an hour unless a shorter window sets its own. */
export interface MailCadence {
  readonly atOnceMs?: number;
  readonly dailyTickMs?: number;
}

export const AT_ONCE_EVERY_MS = 15_000;

/**
 * Run both passes on their intervals over `targets`, one of each kind at a
 * time: a pass still running when its next is due is skipped, not stacked.
 * `timing` is read at the start of every pass, so a sending subdomain whose
 * setup check stops verifying stops the next pass's sends. A business
 * whose pass fails is logged by its kind of pass only (never an address, a
 * link or the fault's text) and the next tick tries it again. `stop` starts
 * no pass and no business after it, and resolves once a pass already running
 * ends, so custody and the pool outlive every send in flight. Within a
 * business it starts no send after it either.
 */
export function startMailWorker(
  database: Database,
  targets: () => Promise<readonly MailTarget[]>,
  timing: () => Promise<EmailTiming>,
  cadence: MailCadence = {},
): { readonly stop: () => Promise<void> } {
  const running: Partial<Record<'at_once' | 'daily', Promise<void>>> = {};
  const stopping = new AbortController();
  const pass = async (kind: 'at_once' | 'daily'): Promise<void> => {
    try {
      const now = await timing();
      for (const { businessId, workerActorId } of await targets()) {
        if (stopping.signal.aborted) break;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one business's sends before the next's
          await deliverDue(database, businessId, workerActorId, now, kind, stopping.signal);
        } catch {
          console.error(`mail worker: a ${kind} pass failed for one business`);
        }
      }
    } catch {
      console.error('mail worker: the pass could not read its sender check or its businesses');
    }
  };
  const once = (kind: 'at_once' | 'daily'): void => {
    if (stopping.signal.aborted || running[kind] !== undefined) return;
    running[kind] = pass(kind).finally(() => {
      delete running[kind];
    });
  };
  const timers = [
    setInterval(() => once('at_once'), cadence.atOnceMs ?? AT_ONCE_EVERY_MS),
    setInterval(() => once('daily'), cadence.dailyTickMs ?? DAY_MS / 24),
  ];
  for (const timer of timers) timer.unref();
  return {
    stop: async () => {
      stopping.abort();
      for (const timer of timers) clearInterval(timer);
      await Promise.all(Object.values(running));
    },
  };
}
