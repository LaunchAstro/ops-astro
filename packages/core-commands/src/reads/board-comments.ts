// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's comment badge (MP-5-8, P-22, P-36): for each row served, how many
// of the reader's own open inbox items (INB-1) of reason `client_comment` and
// of reason `mention` are about that task, and when the newest was raised. One
// query for the whole board, asked only of the rows already served under the
// reader's grants, so an item about a task the reader cannot read is never
// looked at. The recipient is the reader: another person's items are never
// counted, even on a task both read.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { BoardComments } from '../../../core-wire/src/index.ts';

export const NO_COMMENTS: BoardComments = { client: 0, mentions: 0, latest: null };

/** Each served row's waiting client signals and mentions, the reader's own; none for no reader. */
export async function readBoardComments(
  tx: TenantQuery,
  taskIds: readonly string[],
  reader: string | null,
): Promise<ReadonlyMap<string, BoardComments>> {
  if (reader === null || taskIds.length === 0) return new Map();
  const rows = await tx.query<{
    readonly task_id: string;
    readonly client: number;
    readonly mentions: number;
    readonly latest: Date;
  }>(
    `select i.subject_record_id as task_id,
            count(*) filter (where i.reason = 'client_comment')::int as client,
            count(*) filter (where i.reason = 'mention')::int as mentions,
            max(i.raised_at) as latest
       from public.inbox_items i
      where i.business_id = $1 and i.recipient_person_id = $2
        and i.subject_record_id = any($3::uuid[])
        and i.work_state = 'open' and i.owed and i.reason in ('client_comment', 'mention')
      group by i.subject_record_id`,
    [tx.businessId, reader, taskIds],
  );
  return new Map(
    rows.map((row) => [
      row.task_id,
      { client: row.client, mentions: row.mentions, latest: row.latest.toISOString() },
    ]),
  );
}
