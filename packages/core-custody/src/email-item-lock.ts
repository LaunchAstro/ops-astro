// SPDX-License-Identifier: AGPL-3.0-only
//
// The email send's hold on one open inbox item and its task, taken first by
// `checkItem` (`broker-email.ts`).

import type { TenantQuery } from '../../core-records/src/index.ts';

interface HeldItem {
  readonly recipient: string;
  readonly subject: string;
}

async function lockOpenItem(tx: TenantQuery, itemId: string): Promise<HeldItem | undefined> {
  const [item] = await tx.query<HeldItem>(
    `select recipient_person_id as recipient, subject_record_id as subject
       from public.inbox_items
      where business_id = $1 and id = $2 and work_state = 'open'
      for update`,
    [tx.businessId, itemId],
  );
  return item;
}

async function holdTask(tx: TenantQuery, taskId: string, wait: boolean): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.records where business_id = $1 and id = $2
        for share${wait ? '' : ' skip locked'}`,
    [tx.businessId, taskId],
  );
  return rows.length > 0;
}

/**
 * Lock the open item and hold its task `for share`, never waiting on the task
 * while holding the item: `task.assign` locks a task, then its items, so every
 * wait here goes task then item. The item is kept only when its task can be
 * held at once. Otherwise the item is released, the task is waited for, and
 * the item is locked again and must still be the open item first read.
 */
export async function holdItem(
  tx: TenantQuery,
  itemId: string,
): Promise<HeldItem | 'ITEM_NOT_OPEN' | 'ITEM_WITHHELD'> {
  await tx.query('savepoint email_item');
  const item = await lockOpenItem(tx, itemId);
  if (item === undefined) return 'ITEM_NOT_OPEN';
  if (await holdTask(tx, item.subject, false)) return item;
  await tx.query('rollback to savepoint email_item');
  await holdTask(tx, item.subject, true);
  const again = await lockOpenItem(tx, itemId);
  if (again === undefined) return 'ITEM_NOT_OPEN';
  return again.recipient === item.recipient && again.subject === item.subject
    ? again
    : 'ITEM_WITHHELD';
}
