// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's two system operations (AW-03): the wrap-up written at
// quiet, and the purge of the body after the business's window.
//
// Both run in the caller's transaction and take the conversation's row lock
// first, the lock `conversation.message` takes, so a message, a wrap-up and a
// purge of one conversation are ordered and none of them reads a body another
// is changing. Neither is a person's command: they are the worker's, and the
// purge's one audit event names the business's worker actor.
//
// The wrap-up is written from records and never from the transcript: its
// request is the first message as a marked quotation, and its seven items and
// item 8 are pointers and facts the tables hold. Wrap-up prose is read by no
// permission, budget or gate check; the purge reads item 8's work again from
// the records, not from the wrap-up.

import { randomUUID } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { advisoryLock, readBusinessSetting } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { itemsOf, requestQuotation, workOf, type Locked } from './conversation-contents.ts';

/** Quiet: twenty-four hours without a message. */
export const QUIET_HOURS = 24;
/** The window's floor (C122-1); its ceiling is the business's work window. */
export const WINDOW_FLOOR_DAYS = 7;
const WINDOW_KEY = 'conversation_window_days';
const WORK_WINDOW_KEY = 'retention_window_days';
export const WRAP_UP_OPERATION = 'conversation.wrap_up';
export const PURGE_OPERATION = 'conversation.purge';

export interface WrapUpRequest {
  readonly conversationId: string;
  /** The code revision the writer runs, recorded on the wrap-up. */
  readonly codeRevision: string;
}

export type WrapUpOutcome =
  | { readonly ok: true; readonly version: number; readonly written: boolean }
  | { readonly ok: false; readonly reason: 'not_quiet' | 'purged' | 'not_found' };

export interface PurgeRequest {
  readonly conversationId: string;
  /** The purge's identity: a second call with it is the same purge. */
  readonly operationId: string;
}

export type PurgeRefusalCode = 'WRAP_UP_ABSENT' | 'WORK_OPEN' | 'NOT_DUE' | 'WINDOW_UNREADABLE';

export type PurgeOutcome =
  | { readonly ok: true; readonly replayed: boolean; readonly messagesPurged: number }
  | { readonly ok: false; readonly code: PurgeRefusalCode | 'NOT_FOUND' };

async function lockConversation(tx: TenantQuery, id: string): Promise<Locked | undefined> {
  const rows = await tx.query<Locked>(
    `select owner_actor_id, scope_record_id, created_at, last_activity_at, body_purged_at,
            purge_operation_id,
            last_activity_at <= now() - make_interval(hours => $3::int) as quiet
       from conversations where business_id = $1 and id = $2
       for update`,
    [tx.businessId, id, QUIET_HOURS],
  );
  return rows[0];
}

/**
 * The wrap-up at quiet, idempotent on the conversation and its last activity:
 * a second pass over the same activity writes nothing, and a pass that dies
 * mid-write leaves nothing, because the version is one insert in the caller's
 * transaction.
 */
export async function writeWrapUp(tx: TenantQuery, request: WrapUpRequest): Promise<WrapUpOutcome> {
  const locked = await lockConversation(tx, request.conversationId);
  if (locked === undefined) return { ok: false, reason: 'not_found' };
  if (locked.body_purged_at !== null) return { ok: false, reason: 'purged' };
  if (!locked.quiet) return { ok: false, reason: 'not_quiet' };
  const versions = await tx.query<{ version: number; covers: boolean }>(
    `select w.version, w.activity_through = c.last_activity_at as covers
       from conversation_wrap_ups w
       join conversations c on c.business_id = w.business_id and c.id = w.conversation_id
      where w.business_id = $1 and w.conversation_id = $2
      order by w.version desc limit 1`,
    [tx.businessId, request.conversationId],
  );
  const latest = versions[0];
  if (latest?.covers === true) return { ok: true, version: latest.version, written: false };
  const version = (latest?.version ?? 0) + 1;
  const work = await workOf(tx, request.conversationId, locked.scope_record_id);
  const items = await itemsOf(tx, request.conversationId, locked, work);
  const leftOpen = work.filter((item) => !item.terminal).map((item) => item.pointer);
  // activity_through is the column's own value, read in SQL: a JavaScript
  // Date holds milliseconds and the column microseconds, so a value that
  // went through one would never equal the activity it covers.
  await tx.query(
    `insert into conversation_wrap_ups
       (business_id, id, conversation_id, version, written_by_operation, code_revision,
        request_quotation, items, left_open, activity_through)
     select $1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, c.last_activity_at
       from conversations c where c.business_id = $1 and c.id = $3`,
    [
      tx.businessId,
      randomUUID(),
      request.conversationId,
      version,
      WRAP_UP_OPERATION,
      request.codeRevision,
      await requestQuotation(tx, request.conversationId),
      JSON.stringify(items),
      JSON.stringify(leftOpen),
    ],
  );
  return { ok: true, version, written: true };
}

/**
 * The window in days, or undefined when it cannot be read: no row, not a
 * whole number, under the floor, or over the work window. An unreadable
 * window stops the purge for the business; the default applies only through
 * the row that says it.
 */
async function windowDays(tx: TenantQuery): Promise<number | undefined> {
  const window = (await readBusinessSetting(tx, WINDOW_KEY))?.value;
  const work = (await readBusinessSetting(tx, WORK_WINDOW_KEY))?.value;
  if (typeof window !== 'number' || !Number.isSafeInteger(window)) return undefined;
  if (typeof work !== 'number' || !Number.isSafeInteger(work)) return undefined;
  return window >= WINDOW_FLOOR_DAYS && window <= work ? window : undefined;
}

/** The business's worker actor, minted once under a lock so two passes share it. */
async function workerActor(tx: TenantQuery): Promise<string> {
  // Its own key, taken last and by nothing that then waits on a conversation,
  // so it joins no cycle with the row locks above it.
  await advisoryLock(tx, `worker-actor:${tx.businessId}`);
  const found = await tx.query<{ id: string }>(
    `select id from actors where business_id = $1 and kind = 'worker' order by id limit 1`,
    [tx.businessId],
  );
  if (found[0] !== undefined) return found[0].id;
  const id = randomUUID();
  await tx.query(`insert into actors (business_id, id, kind) values ($1, $2, 'worker')`, [
    tx.businessId,
    id,
  ]);
  return id;
}

/**
 * The purge: the body goes, the conversation and its wrap-ups stay.
 *
 * Refused, writing nothing, without a wrap-up covering the conversation's
 * last activity (`WRAP_UP_ABSENT`; the database refuses a message delete
 * without one too), while any work it cited or started is open
 * (`WORK_OPEN`), before the window has passed since the later of its last
 * activity and its work's end (`NOT_DUE`), and when the window cannot be read
 * (`WINDOW_UNREADABLE`). Transactional and idempotent: a purged conversation
 * answers `replayed` and writes no second audit event.
 */
export async function purgeConversation(
  tx: TenantQuery,
  request: PurgeRequest,
): Promise<PurgeOutcome> {
  const locked = await lockConversation(tx, request.conversationId);
  if (locked === undefined) return { ok: false, code: 'NOT_FOUND' };
  if (locked.body_purged_at !== null) return { ok: true, replayed: true, messagesPurged: 0 };
  const window = await windowDays(tx);
  if (window === undefined) return { ok: false, code: 'WINDOW_UNREADABLE' };
  const covering = await tx.query<{ n: string }>(
    `select count(*)::text as n from conversation_wrap_ups w
       join conversations c on c.business_id = w.business_id and c.id = w.conversation_id
      where w.business_id = $1 and w.conversation_id = $2
        and w.activity_through = c.last_activity_at`,
    [tx.businessId, request.conversationId],
  );
  if (covering[0]?.n === '0') return { ok: false, code: 'WRAP_UP_ABSENT' };
  const work = await workOf(tx, request.conversationId, locked.scope_record_id);
  if (work.some((item) => !item.terminal)) return { ok: false, code: 'WORK_OPEN' };
  const since = work.reduce(
    (latest, item) => (item.endedAt !== null && item.endedAt > latest ? item.endedAt : latest),
    locked.last_activity_at,
  );
  const due = await tx.query<{ due: boolean }>(
    `select $1::timestamptz <= now() - make_interval(days => $2::int) as due`,
    [since, window],
  );
  if (due[0]?.due !== true) return { ok: false, code: 'NOT_DUE' };
  const purged = await tx.query<{ id: string }>(
    `delete from conversation_messages
      where business_id = $1 and conversation_id = $2 returning id`,
    [tx.businessId, request.conversationId],
  );
  await tx.query(
    `update conversations set body_purged_at = now(), purge_operation_id = $3
      where business_id = $1 and id = $2`,
    [tx.businessId, request.conversationId, request.operationId],
  );
  await writeAuditEvent(tx, {
    actorId: await workerActor(tx),
    command: PURGE_OPERATION,
    operationId: request.operationId,
    outcome: 'applied',
    subjectRecordId: null,
    payloadDigest: payloadDigest({ conversationId: request.conversationId }),
  });
  return { ok: true, replayed: false, messagesPurged: purged.length };
}
