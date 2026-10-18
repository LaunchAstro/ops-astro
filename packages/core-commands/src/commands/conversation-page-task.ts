// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's page task (#1467): the task its stored page names
// (`conversation.set_scope`, `/task/<key or id>`), or else the task it was
// opened on, so "Add page to context" sends what a conversation opened on that
// task sends, judged the same way (`conversation-context.ts`, `pageOf`), and a
// client's page added since is judged as that client's (S1930-1). The exchange,
// the message keep and the models offered all ask it, so they judge one page.
// An added page naming no task of this business is judged as a task that is
// gone, never told apart from one the caller may not read; any other page
// leaves the task it was opened on.

import { isUuid, slotOf, TASK_SPINE, taskPageRef } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

const KEY = slotOf(TASK_SPINE, 'key');
/** An id no task holds: `pageOf` answers it as a task that is gone. */
const NO_TASK = '00000000-0000-4000-8000-000000000000';

export async function pageTaskOf(
  tx: TenantQuery,
  scopeRecordId: string | null,
  pageAddress: string | null,
): Promise<string | null> {
  const named = taskPageRef(pageAddress);
  if (named === undefined) return scopeRecordId;
  if (named === null) return NO_TASK;
  const [task] = await tx.query<{ readonly id: string }>(
    `select r.id from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and t.key = 'task' and r.deleted_at is null
        and (r.${KEY} = $2 or ($3::uuid is not null and r.id = $3::uuid))`,
    [tx.businessId, named, isUuid(named) ? named : null],
  );
  return task?.id ?? NO_TASK;
}
