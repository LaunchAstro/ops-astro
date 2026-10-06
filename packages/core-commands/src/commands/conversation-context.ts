// SPDX-License-Identifier: AGPL-3.0-only
//
// What the exchange sends beside the person's message, and what the answer
// cites. Read in the exchange's first transaction, with the conversation's
// page task held `for share`, so the client check, the grant check and the
// title sent are one moment's facts.
//
// - The page: the task's id and title only. Never its body or any other
//   field of the record. A task with a client, a task gone, or one the
//   caller holds no `task:read` on is `refused`: owner line 72 asks no model.
//   A caller without the read is refused before the task is read or locked,
//   so a revoked reader never waits behind the task's writer. A refusal is
//   marked in the audit chain in the same transaction, as the broker marks
//   its own, and so is a question kept while its page is a client's, in the
//   transaction that keeps it. The keep judges the page as the exchange does
//   (the read first, then the share lock, then the read again), before it
//   asks its own write grant, so no grant counts across that wait. A question
//   kept on a page its sender may not read is marked too, the task untouched.
//   The mark names its reason: CLIENT_MODEL_USE_OFF for a client's task,
//   SCOPE_NOT_GRANTED for a page out of the sender's reads, NOT_FOUND for one
//   gone; the person is answered the same for each.
//   A marked message is refused ever after: sent
//   again with its operation id once the client is cleared or the task
//   purged, it asks no model.
// - Earlier: this conversation's messages before the asked one, oldest
//   first, each labelled by role, and only what a model already had: the
//   agent's replies and the questions they answer. A question refused (a
//   client's task among them) never rides in later. At most the last ten, at most
//   `EARLIER_LIMIT` characters in all, and no more than lets the whole GPT
//   request fit the runner's `LOCAL_GPT_BODY_LIMIT` bytes, the oldest dropped first.
// - Cites: the page task, by its own key, when the page is sent. Never a
//   string the model wrote.

import {
  CONVERSATION_ANSWER,
  LOCAL_GPT_BODY_LIMIT,
  localGptAdapter,
} from '../../../core-connectors/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import {
  advisoryLock,
  heldScopes,
  slotOf,
  subjectsOf,
  TASK_SPINE,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { writeAuditEvent } from './audit.ts';

/** A record the answer read, with the product's own address for it. */
export interface Cite {
  readonly label: string;
  readonly href: string;
}

export interface Context {
  /** The page task is a client's, gone, or out of the caller's grants. */
  readonly refused: boolean;
  /** The extra prompt fields, in the order the model reads them; empty ones are left out. */
  readonly fields: readonly { readonly name: 'page' | 'earlier'; readonly value: string }[];
  readonly cites: readonly Cite[];
}

export const EARLIER_COUNT = 10;
export const EARLIER_LIMIT = 8_000;
export const PAGE_TITLE_LIMIT = 200;

const CLIENT = slotOf(TASK_SPINE, 'client');
const KEY = slotOf(TASK_SPINE, 'key');
// The title is `txt_4`, the slot `reads/tasks.ts` reads.
const TITLE = 'txt_4';

interface PageRow {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly client: string | null;
}

/** Whether the caller holds `task:read` on the task, business-wide or on the record. */
async function reads(tx: TenantQuery, session: Session, taskId: string): Promise<boolean> {
  const scopes = await heldScopes(tx, subjectsOf(session), { collection: 'task', action: 'read' });
  return scopes.some(
    (scope) => scope.kind === 'business' || (scope.kind === 'record' && scope.id === taskId),
  );
}

/** Why a page is refused, as its mark records it. */
export type PageRefusal = 'CLIENT_MODEL_USE_OFF' | 'SCOPE_NOT_GRANTED' | 'NOT_FOUND';
const PAGE_REFUSALS: readonly PageRefusal[] = [
  'CLIENT_MODEL_USE_OFF',
  'SCOPE_NOT_GRANTED',
  'NOT_FOUND',
];

/** The page task, held for share, if the caller may read it and it is no client's. */
async function pageOf(
  tx: TenantQuery,
  session: Session,
  taskId: string,
): Promise<PageRow | PageRefusal> {
  // Before the task is touched: a caller who may not read it neither waits on its writer nor reads it.
  if (!(await reads(tx, session, taskId))) return 'SCOPE_NOT_GRANTED';
  // A separate select: Postgres refuses FOR SHARE on the nullable side of an outer join.
  const [task] = await tx.query<PageRow>(
    `select id, ${KEY} as key, ${TITLE} as title, ${CLIENT} as client
       from records
      where business_id = $1 and id = $2 and deleted_at is null
      for share`,
    [tx.businessId, taskId],
  );
  if (task === undefined) return 'NOT_FOUND';
  if (task.client !== null) return 'CLIENT_MODEL_USE_OFF';
  // Asked again once the task is held, so a grant revoked while this waited is seen.
  return (await reads(tx, session, taskId)) ? task : 'SCOPE_NOT_GRANTED';
}

/** Whether the whole GPT request, as the adapter writes it, fits the runner's body limit. */
const fits = (fields: Readonly<Record<string, string>>): boolean =>
  Buffer.byteLength(localGptAdapter(fields).body) <= LOCAL_GPT_BODY_LIMIT;

/** The last ten earlier messages as JSON, oldest dropped until it fits both bounds. */
function earlierOf(
  rows: readonly { readonly role: string; readonly body: string }[],
  around: Readonly<Record<string, string>>,
): string {
  let kept = rows.slice(-EARLIER_COUNT).map(({ role, body }) => ({ role, body }));
  let text = JSON.stringify(kept);
  while (kept.length > 0 && (text.length > EARLIER_LIMIT || !fits({ ...around, earlier: text }))) {
    kept = kept.slice(1);
    text = JSON.stringify(kept);
  }
  return kept.length === 0 ? '' : text;
}

/** The audit action a message refused for its page is marked with, as the broker's refusals are. */
const REFUSED_CALL = 'model.call_refused';
const REFUSED: Context = { refused: true, fields: [], cites: [] };

type Asked = { readonly conversationId: string; readonly messageId: string };

/** Whether this message was ever refused for its page. */
async function markedRefused(tx: TenantQuery, asked: Asked): Promise<boolean> {
  const [row] = await tx.query<{ readonly marked: boolean }>(
    `select exists (
       select 1 from audit_events
        where business_id = $1 and command = $2 and refusal_code = any($3::text[])
          and attempted ->> 'operation' = $4
          and attempted ->> 'conversationId' = $5 and attempted ->> 'messageId' = $6) as marked`,
    [
      tx.businessId,
      REFUSED_CALL,
      PAGE_REFUSALS,
      CONVERSATION_ANSWER.key,
      asked.conversationId,
      asked.messageId,
    ],
  );
  return row?.marked === true;
}

/** Marks the message refused for its page, with why, in the transaction that judged it so. */
export async function markRefusedForPage(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  code: PageRefusal,
): Promise<Context> {
  const { conversationId, messageId } = asked;
  const detail = {
    operation: CONVERSATION_ANSWER.key,
    conversationId,
    messageId,
    code,
  };
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: REFUSED_CALL,
    outcome: 'refused',
    refusalCode: code,
    payloadDigest: payloadDigest(detail),
    attempted: detail,
  });
  return REFUSED;
}

/**
 * At keep, before the keep asks its grants: whether a question kept on this
 * page task is refused for it (a client's, gone, or not the sender's to read),
 * and why. The caller marks it once the message is written.
 */
export async function keptRefused(
  tx: TenantQuery,
  session: Session,
  taskId: string | null,
): Promise<PageRefusal | null> {
  if (taskId === null) return null;
  const page = await pageOf(tx, session, taskId);
  return typeof page === 'string' ? page : null;
}

/**
 * A keep's waits, made before it asks its grants (Sol PRV-oa-1088-SC1,
 * SEC1-1): the page task judged under its share lock, then the audit chain's
 * lock, which its own audit events and the envelope's would otherwise wait on
 * after the check, so a grant a chain holder ended is seen. The chain key is
 * the trigger's, `business_id::text`, which is lower case. Answers why the
 * page refuses the question, if it does.
 */
export async function waitsFirst(
  tx: TenantQuery,
  session: Session,
  taskId: string | null,
): Promise<PageRefusal | null> {
  const pageRefused = await keptRefused(tx, session, taskId);
  await advisoryLock(tx, tx.businessId.toLowerCase());
  return pageRefused;
}

/** The page and earlier messages for the asked message, in the caller's transaction. */
export async function contextOf(
  tx: TenantQuery,
  session: Session,
  asked: Asked & { readonly body: string },
  scopeRecordId: string | null,
): Promise<Context> {
  const page = scopeRecordId === null ? null : await pageOf(tx, session, scopeRecordId);
  // Asked once the page is held, so a twin's refusal committed while this waited is seen.
  const marked = await markedRefused(tx, asked);
  if (typeof page === 'string') {
    return marked ? REFUSED : await markRefusedForPage(tx, session, asked, page);
  }
  if (marked) return REFUSED;
  const rows = await tx.query<{ readonly role: string; readonly body: string }>(
    `select role, body from (
       select m.role, m.body, m.created_at, m.id
         from conversation_messages m
         join conversation_messages a
           on a.business_id = m.business_id and a.conversation_id = m.conversation_id
        where m.business_id = $1 and m.conversation_id = $2 and a.id = $3
          and m.role in ('person', 'agent') and m.created_at < a.created_at
          and (m.role = 'agent' or exists (
            select 1 from conversation_messages r
             where r.business_id = m.business_id and r.conversation_id = m.conversation_id
               and r.answers_message_id = m.id))
        order by m.created_at desc, m.id desc
        limit $4) last
      order by created_at, id`,
    [tx.businessId, asked.conversationId, asked.messageId, EARLIER_COUNT],
  );
  const fields: Context['fields'][number][] = [];
  const cites: Cite[] = [];
  if (page !== null) {
    const title = (page.title ?? '').slice(0, PAGE_TITLE_LIMIT);
    fields.push({ name: 'page', value: JSON.stringify({ task: page.id, title }) });
    if (page.key !== null && page.key !== '') {
      cites.push({
        label: title === '' ? page.key : title,
        href: `/task/${encodeURIComponent(page.key)}`,
      });
    }
  }
  const around = Object.fromEntries([
    ...fields.map(({ name, value }) => [name, value]),
    ['message', asked.body],
  ]);
  const earlier = earlierOf(rows, around);
  if (earlier !== '') fields.push({ name: 'earlier', value: earlier });
  return { refused: false, fields, cites };
}
