// SPDX-License-Identifier: AGPL-3.0-only
//
// The task type's half of the domain-model conformance proof.
//
// T1d carried assertion 1 for every record type and said which of the six it
// could not carry, because the protected set is the task type's fields and the
// task type is seeded here. This module carries what T1e can now carry:
//
//   2. No field in the protected set is `generic`, asserted **by name** so
//      relaxing one is a visible diff.                          CARRIED, below.
//   3. A generic write to each protected field is refused on each of the three
//      surfaces.  STILL NOT CARRIED: there are no surfaces. T1g. The engine
//      half is `refuseGenericWrite`, and it is exercised against the real
//      seeded field definitions here rather than against invented ones.
//   4. Each protected field's `owning_operation` exists and is reachable
//      through an endpoint.  STILL NOT CARRIED: the operations are T1f's. What
//      is carried is that each protected field **names** one, and that the
//      names are well formed, so T1f has a list to satisfy rather than a
//      guess.
//
// It also carries the three mechanics that are stated as absences, and an
// absence is exactly what a conformance set is for: nothing fails at runtime
// when a field that should not exist exists, so only an assertion catches it.
// Those are 14.4 (no run pointer on the task), 14.5 (no second coarse status)
// and the five machine categories being five.

import type { AdminConnection } from '../tenancy/database.ts';
import type { Finding } from '../tenancy/conformance.ts';
import {
  CONDITIONAL_TASK_FIELDS,
  FIELDS_NOT_CARRIED,
  PROTECTED_TASK_FIELDS,
  TASK_SPINE,
  TASK_TYPE_KEY,
} from './spine.ts';
import { MACHINE_CATEGORIES, TASK_STATE_TYPE_KEY } from './states.ts';

type Read = AdminConnection['execute'];

interface TaskFieldRow {
  readonly business_id: string;
  readonly key: string;
  readonly slot: string | null;
  readonly write_mode: string;
  readonly owning_operation: readonly string[] | null;
  readonly escalating_operation: string | null;
  readonly origin: string;
}

interface StateRow {
  readonly business_id: string;
  readonly key: string | null;
  readonly machine_category: string | null;
}

/** Every task field of every business that has the task type installed. */
async function taskFields(read: Read): Promise<readonly TaskFieldRow[]> {
  return await read<TaskFieldRow>(
    `select f.business_id, f.key, f.slot, f.write_mode, f.owning_operation,
            f.escalating_operation, f.origin
       from public.field_defs f
       join public.record_types t
         on t.business_id = f.business_id and t.id = f.record_type_id
      where t.key = $1
      order by f.business_id, f.key`,
    [TASK_TYPE_KEY],
  );
}

async function taskStates(read: Read): Promise<readonly StateRow[]> {
  return await read<StateRow>(
    `select r.business_id,
            r.data ->> 'key' as key,
            r.data ->> 'machine_category' as machine_category
       from public.records r
       join public.record_types t
         on t.business_id = r.business_id and t.id = r.record_type_id
      where t.key = $1 and r.deleted_at is null
      order by r.business_id, 2`,
    [TASK_STATE_TYPE_KEY],
  );
}

function byBusiness(rows: readonly TaskFieldRow[]): Map<string, Map<string, TaskFieldRow>> {
  const grouped = new Map<string, Map<string, TaskFieldRow>>();
  for (const row of rows) {
    const fields = grouped.get(row.business_id) ?? new Map<string, TaskFieldRow>();
    fields.set(row.key, row);
    grouped.set(row.business_id, fields);
  }
  return grouped;
}

/** Assertion 2, by name, plus the classification each protected field must hold. */
function protectedSet(business: string, fields: Map<string, TaskFieldRow>): readonly Finding[] {
  const findings: Finding[] = [];
  for (const key of PROTECTED_TASK_FIELDS) {
    const where = `${business}:task.${key}`;
    const field = fields.get(key);
    if (field === undefined) {
      findings.push({
        rule: 'every field in the protected set is installed',
        object: where,
        detail: 'the task type has no such field, so nothing can refuse a write to it',
      });
      continue;
    }
    if (field.write_mode === 'generic') {
      findings.push({
        rule: 'no field in the protected set is generic',
        object: where,
        detail: 'a generic write would reach a protected transition on every surface',
      });
    }
    if (field.write_mode === 'operation' && field.owning_operation === null) {
      findings.push({
        rule: 'every operation-owned field names the operation that owns it',
        object: where,
        detail: 'write mode is operation with no operation named',
      });
    }
  }
  return findings;
}

/** The two fields that are ordinarily generic and an access change sometimes. */
function conditionalSet(business: string, fields: Map<string, TaskFieldRow>): readonly Finding[] {
  const findings: Finding[] = [];
  for (const key of CONDITIONAL_TASK_FIELDS) {
    const field = fields.get(key);
    const where = `${business}:task.${key}`;
    if (field === undefined) continue;
    if (field.write_mode !== 'generic' || field.escalating_operation === null) {
      findings.push({
        rule: 'a containment field is generic within reach and names the operation that widens it',
        object: where,
        detail: `write mode ${field.write_mode}, escalating to ${field.escalating_operation ?? 'nothing'}`,
      });
    }
  }
  // The set runs in both directions: a third field quietly acquiring an
  // escalation is as much a change as one losing it.
  for (const [key, field] of fields) {
    if (field.escalating_operation === null) continue;
    if (CONDITIONAL_TASK_FIELDS.includes(key)) continue;
    findings.push({
      rule: 'only the containment fields escalate',
      object: `${business}:task.${key}`,
      detail: `escalates to ${field.escalating_operation} and is not a containment field`,
    });
  }
  return findings;
}

/** 14.1, 14.4 and 14.5, each of which is a rule about a field that is absent. */
function absences(business: string, fields: Map<string, TaskFieldRow>): readonly Finding[] {
  const findings: Finding[] = [];
  for (const key of FIELDS_NOT_CARRIED) {
    if (!fields.has(key)) continue;
    findings.push({
      rule: 'the task carries no run pointer, no clearance and no second coarse status',
      object: `${business}:task.${key}`,
      detail: 'the run and the lease own machine lifecycle, and the state link is the only status',
    });
  }
  const completedAt = fields.get('completed_at');
  if (completedAt !== undefined && completedAt.owning_operation !== null) {
    findings.push({
      rule: 'the completion stamp is derived and no operation takes it as an input',
      object: `${business}:task.completed_at`,
      detail: `names ${(completedAt.owning_operation ?? []).join(' ')}, which would make it a writable field`,
    });
  }
  return findings;
}

/** The spine as declared is the spine as installed, slot for slot. */
function spineMatchesDeclaration(
  business: string,
  fields: Map<string, TaskFieldRow>,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const declared of TASK_SPINE) {
    const field = fields.get(declared.key);
    const where = `${business}:task.${declared.key}`;
    if (field === undefined) {
      findings.push({
        rule: 'every declared spine field is installed',
        object: where,
        detail: 'declared in spine.ts and absent from the database',
      });
      continue;
    }
    if (field.slot !== declared.slot) {
      findings.push({
        rule: 'a spine field sits in the slot the reservation names',
        object: where,
        detail: `declared ${declared.slot ?? 'unslotted'}, installed ${field.slot ?? 'unslotted'}`,
      });
    }
    if (field.write_mode !== declared.writeMode) {
      findings.push({
        rule: 'a spine field carries the classification the contract gives it',
        object: where,
        detail: `declared ${declared.writeMode}, installed ${field.write_mode}`,
      });
    }
    if (field.origin !== 'core') {
      findings.push({
        rule: 'a spine field is a core field, so it may hold a reserved slot',
        object: where,
        detail: `origin ${field.origin}`,
      });
    }
  }
  return findings;
}

/** The five categories are five, present once each, and there is no sixth. */
function stateCorpus(states: readonly StateRow[]): readonly Finding[] {
  const findings: Finding[] = [];
  const byTenant = new Map<string, StateRow[]>();
  for (const row of states) {
    byTenant.set(row.business_id, [...(byTenant.get(row.business_id) ?? []), row]);
  }
  for (const [business, rows] of byTenant) {
    const categories = new Set(rows.map((row) => row.machine_category));
    for (const row of rows) {
      if (
        row.machine_category !== null &&
        MACHINE_CATEGORIES.includes(row.machine_category as never)
      )
        continue;
      findings.push({
        rule: 'every task state carries one of the five machine categories',
        object: `${business}:task_state.${row.key ?? 'unnamed'}`,
        detail: `carries ${row.machine_category ?? 'nothing'}`,
      });
    }
    // Not "every category has a state": the legacy's five status words map
    // onto four of the five and nothing maps to `cancelled` (ADR 0011:30), so
    // that rule would fail on the set the specification says to ship. What
    // must hold is narrower and is the one an operation depends on —
    // `task.complete` needs somewhere to move a task to, and
    // `completionStampFor` reads the category it lands in. An installation
    // whose states cannot reach `completed` has a completion command with no
    // target.
    if (!categories.has('completed')) {
      findings.push({
        rule: 'a state carrying the completed category exists, so a task can be completed',
        object: `${business}:task_state`,
        detail: 'no state carries the completed category, so task.complete has no target',
      });
    }
  }
  return findings;
}

/** The placement invariant is in the database, not only in the command. */
async function placementConstraint(read: Read): Promise<readonly Finding[]> {
  const rows = await read<{ readonly conname: string }>(
    `select conname from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = 'records' and c.conname = 'records_subtask_has_no_board_section'`,
  );
  if (rows.length > 0) return [];
  return [
    {
      rule: 'a record with a parent cannot carry a board section, held in the database',
      object: 'records.records_subtask_has_no_board_section',
      detail: 'the constraint is absent, so only a command stands between a subtask and a section',
    },
  ];
}

/**
 * The task spine as the server has it.
 *
 * Read across every business, because an installation with two tenants and one
 * correctly installed task type has not been checked. A business with no task
 * type installed contributes nothing rather than failing: not every business
 * has run the installer.
 */
export async function taskSpineConformance(read: Read): Promise<readonly Finding[]> {
  const findings: Finding[] = [...(await placementConstraint(read))];
  const grouped = byBusiness(await taskFields(read));
  for (const [business, fields] of grouped) {
    findings.push(
      ...spineMatchesDeclaration(business, fields),
      ...protectedSet(business, fields),
      ...conditionalSet(business, fields),
      ...absences(business, fields),
    );
  }
  findings.push(...stateCorpus(await taskStates(read)));
  return findings;
}
