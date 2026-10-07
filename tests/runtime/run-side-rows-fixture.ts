// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { liveWork, type Schedules } from './schedules-harness.ts';
import { seedPin } from './aw-02-world.ts';
export interface RunRows {
  readonly run_id: string;
  readonly step_id: string;
  readonly lease_id: string;
  readonly version_id: string;
  readonly reservation_id: string;
  readonly attempt_id: string;
  readonly task_id: string;
}
export type Row = Record<string, string | number | boolean | null>;
export let s: Schedules;
export let own: RunRows;
export let other: RunRows;
let sequence = 0;
export async function insert(table: string, row: Row): Promise<void> {
  const entries = Object.entries({ business_id: s.business, id: randomUUID(), ...row });
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.${table} (${entries.map(([key]) => key).join(', ')})
       values (${entries.map((_, index) => `$${index + 1}`).join(', ')})`,
      entries.map(([, value]) => value),
    );
  });
}
export function child(table: string): Row {
  if (table === 'bootstrap_reads') {
    return {
      run_id: own.run_id,
      step_id: own.step_id,
      sequence: ++sequence,
      path: 'skills/brief/SKILL.md',
      content_digest: 'a'.repeat(64),
      content_size: 1,
      is_entry: false,
    };
  }
  if (table === 'run_checks') {
    return {
      run_id: own.run_id,
      task_id: own.task_id,
      version_id: own.version_id,
      lease_id: own.lease_id,
      attempt_id: own.attempt_id,
      actor_id: s.agentActorId,
      fence: 1,
      name: 'run check',
      outcome: 'passed',
    };
  }
  return {
    run_id: own.run_id,
    step_id: own.step_id,
    version_id: own.version_id,
    lease_id: own.lease_id,
    reservation_id: own.reservation_id,
    operation_key: 'test.compose',
    state: 'liability_unknown',
    reserved_minor: 1,
    route_key: 'test',
    route_reach: 'cloud',
    credential_kind: 'replay',
    drop_cause: 'provider_unavailable',
    fault: 'provider',
    provider_code: 'http_503',
    unknown_since: new Date().toISOString(),
  };
}
export function conversationCall(conversationId: string): Row {
  return {
    conversation_id: conversationId,
    operation_key: 'test.compose',
    route_key: 'test',
    route_reach: 'local',
    credential_kind: 'replay',
    state: 'reserved',
    reserved_minor: 0,
  };
}
export async function seedRunRows(): Promise<void> {
  const first = await liveWork(s, 'First run', 2_000);
  const second = await liveWork(s, 'Second run', 2_000);
  const rows = await s.db.admin.execute<RunRows>(
    `select a.run_id, a.step_id, a.lease_id, a.version_id, a.reservation_id,
              a.id as attempt_id, l.task_id
         from public.attempts a join public.leases l
           on l.business_id = a.business_id and l.id = a.lease_id
        where a.business_id = $1 and a.lease_id in ($2, $3)`,
    [s.business, first.picked['leaseId'], second.picked['leaseId']],
  );
  const firstRow = rows.find((row) => row.lease_id === first.picked['leaseId']);
  const secondRow = rows.find((row) => row.lease_id === second.picked['leaseId']);
  if (firstRow === undefined || secondRow === undefined) throw new Error('missing run rows');
  own = firstRow;
  other = secondRow;
  await seedPin(s, own.run_id);
}
export const CROSS_RUN = [
  ['bootstrap_reads', 'step_id'],
  ['run_checks', 'lease_id'],
  ['run_checks', 'attempt_id'],
  ['run_checks', 'task_id'],
  ['model_calls', 'step_id'],
  ['model_calls', 'lease_id'],
  ['model_calls', 'reservation_id'],
  ['model_calls', 'version_id'],
] as const;
export async function snapshot(): Promise<unknown> {
  return await s.db.admin.execute(
    `select * from (
       select 'bootstrap_reads' as table_name, to_jsonb(r) as row from public.bootstrap_reads r
       union all select 'run_checks', to_jsonb(r) from public.run_checks r
       union all select 'model_calls', to_jsonb(r) from public.model_calls r
     ) rows order by table_name, row::text`,
  );
}

export function setSchedules(value: Schedules): void {
  s = value;
}
