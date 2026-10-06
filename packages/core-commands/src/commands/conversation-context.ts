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
// - Earlier: this conversation's messages before the asked one, oldest
//   first, each labelled by role, and only what a model already had: the
//   agent's replies and the questions they answer. A question refused (a
//   client's task among them) never rides in later. At most the last ten, and at most
//   `EARLIER_LIMIT` characters in all, the oldest dropped first.
// - Cites: the page task, by its own key, when the page is sent. Never a
//   string the model wrote.

import { heldScopes, slotOf, subjectsOf, TASK_SPINE } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';

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

/** The page task, held for share, if the caller may read it and it is no client's. */
async function pageOf(
  tx: TenantQuery,
  session: Session,
  taskId: string,
): Promise<PageRow | 'refused'> {
  // A separate select: Postgres refuses FOR SHARE on the nullable side of an outer join.
  const [task] = await tx.query<PageRow>(
    `select id, ${KEY} as key, ${TITLE} as title, ${CLIENT} as client
       from records
      where business_id = $1 and id = $2 and deleted_at is null
      for share`,
    [tx.businessId, taskId],
  );
  if (task === undefined || task.client !== null) return 'refused';
  const scopes = await heldScopes(tx, subjectsOf(session), { collection: 'task', action: 'read' });
  const reads = scopes.some(
    (scope) => scope.kind === 'business' || (scope.kind === 'record' && scope.id === taskId),
  );
  return reads ? task : 'refused';
}

/** The last ten earlier messages as JSON, oldest dropped until it fits the bound. */
function earlierOf(rows: readonly { readonly role: string; readonly body: string }[]): string {
  let kept = rows.slice(-EARLIER_COUNT).map(({ role, body }) => ({ role, body }));
  let text = JSON.stringify(kept);
  while (kept.length > 0 && text.length > EARLIER_LIMIT) {
    kept = kept.slice(1);
    text = JSON.stringify(kept);
  }
  return kept.length === 0 ? '' : text;
}

/** The page and earlier messages for the asked message, in the caller's transaction. */
export async function contextOf(
  tx: TenantQuery,
  session: Session,
  asked: { readonly conversationId: string; readonly messageId: string },
  scopeRecordId: string | null,
): Promise<Context> {
  const page = scopeRecordId === null ? null : await pageOf(tx, session, scopeRecordId);
  if (page === 'refused') return { refused: true, fields: [], cites: [] };
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
  const earlier = earlierOf(rows);
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
  if (earlier !== '') fields.push({ name: 'earlier', value: earlier });
  return { refused: false, fields, cites };
}
