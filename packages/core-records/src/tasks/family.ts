// SPDX-License-Identifier: AGPL-3.0-only
//
// A task and its subtasks, read together (MP-4-4, CS-15.19).
//
// A subtask is a full task whose `parent` slot (`uuid_4`) names another, so a
// parent and its children are one statement over the records table: the
// parent by its id, the children by the slot, both filtered by the business
// the session set. A record grant on the parent is not one on its children,
// so a child comes back only when the reader's live `task:read` grants reach
// it, asked inside the same statement: a child the reader may not read never
// leaves the database, not even its title (catalogue #412). The parent is
// the caller's to have admitted.

import { askedFor, EFFECTIVE, type Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

export interface FamilyRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly key: string;
  readonly title: string | null;
  readonly revision: number;
  readonly state: {
    readonly id: string;
    readonly key: string;
    readonly label: string;
    readonly machineCategory: string;
  } | null;
  readonly assignee: { readonly personId: string; readonly name: string } | null;
  readonly archived: { readonly at: string; readonly why: string } | null;
}

export interface TaskFamily {
  readonly parent: FamilyRow | undefined;
  /** In the order the parent's page lists them: the sibling rank, then age. */
  readonly children: readonly FamilyRow[];
}

interface Row {
  readonly id: string;
  readonly parent_id: string | null;
  readonly key: string | null;
  readonly title: string | null;
  readonly revision: string;
  readonly state_id: string | null;
  readonly state_key: string | null;
  readonly state_label: string | null;
  readonly state_category: string | null;
  readonly assignee_id: string | null;
  readonly assignee_name: string | null;
  readonly archived_at: string | null;
  readonly archived_why: string | null;
}

function familyRow(row: Row): FamilyRow {
  return {
    id: row.id,
    parentId: row.parent_id,
    key: row.key ?? '',
    title: row.title,
    revision: Number(row.revision),
    state:
      row.state_id === null
        ? null
        : {
            id: row.state_id,
            key: row.state_key ?? '',
            label: row.state_label ?? '',
            machineCategory: row.state_category ?? '',
          },
    assignee:
      row.assignee_id === null
        ? null
        : { personId: row.assignee_id, name: row.assignee_name ?? '' },
    archived:
      row.archived_at === null ? null : { at: row.archived_at, why: row.archived_why ?? '' },
  };
}

export async function readTaskFamily(
  tx: TenantQuery,
  taskTypeId: string,
  parentId: string,
  readers: readonly Subject[],
): Promise<TaskFamily> {
  const asked = askedFor(readers, { collection: 'task', action: 'read' });
  const rows = await tx.query<Row>(
    `${EFFECTIVE}
     select r.id, r.uuid_4::text as parent_id, r.txt_1 as key, r.txt_4 as title,
            r.revision::text as revision,
            s.id as state_id, s.data ->> 'key' as state_key, s.data ->> 'label' as state_label,
            s.data ->> 'machine_category' as state_category,
            p.id as assignee_id, p.display_name as assignee_name,
            r.data ->> 'archived_at' as archived_at, r.data ->> 'archived_why' as archived_why
       from public.records r
       left join public.records s
         on s.business_id = r.business_id and s.id = r.uuid_1 and s.deleted_at is null
       left join public.people p
         on p.business_id = r.business_id and p.id = r.uuid_2
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and (r.id = $3::uuid
             or (r.uuid_4 = $3::uuid
                 and exists (
                   select 1 from effective e
                    where e.collection = 'task'
                      and e.action = 'read'
                      and exists (select 1 from unnest($4::text[], $5::uuid[]) as s (kind, id)
                                   where s.kind = e.subject_kind and s.id = e.subject_id)
                      and (e.scope_kind = 'business'
                           or (e.scope_kind = 'record' and e.scope_id = r.id)))))
      order by r.num_2 nulls last, r.created_at, r.id`,
    [
      tx.businessId,
      taskTypeId,
      parentId,
      asked.map((subject) => subject.kind),
      asked.map((subject) => subject.id),
    ],
  );
  const family = rows.map((row) => familyRow(row));
  return {
    parent: family.find((row) => row.id === parentId),
    children: family.filter((row) => row.id !== parentId),
  };
}
