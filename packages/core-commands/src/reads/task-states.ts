// SPDX-License-Identifier: AGPL-3.0-only
//
// The business's task states, as the status select offers them (Stage 1
// adds): every live state record of this business, in the workflow's order
// (`position`, the order the board groups in), each with the id
// `task.set_state` takes and the label a person reads. States are records of
// the business, so a tenant query reaches only its own.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { TaskStateView } from '../../../core-wire/src/index.ts';

export async function readStateChoices(
  tx: TenantQuery,
  taskStateTypeId: string,
): Promise<readonly TaskStateView[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly key: string | null;
    readonly label: string | null;
    readonly machine_category: string | null;
  }>(
    `select id, data ->> 'key' as key, data ->> 'label' as label,
            data ->> 'machine_category' as machine_category
       from public.records
      where business_id = $1 and record_type_id = $2 and deleted_at is null
      order by num_1, id`,
    [tx.businessId, taskStateTypeId],
  );
  return rows.map((row) => ({
    id: row.id,
    key: row.key ?? '',
    label: row.label ?? '',
    machineCategory: row.machine_category ?? '',
  }));
}
