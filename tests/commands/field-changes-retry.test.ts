// SPDX-License-Identifier: AGPL-3.0-only
//
// P20 (U115): the field names are written in the command's own transaction.
// When the applied audit event cannot be written, the task, the register row
// and the names all roll back together; the same request sent again applies
// once and records its names once. A replay of that operation answers what was
// stored and records no second set, and once the caller's grant is revoked
// the envelope's existing authority check refuses the replay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { randomUUID } from 'node:crypto';
import { eventsOf, made, operationsOf, taskRow, update } from './field-changes-world.ts';

const configured = databaseUrlFromEnvironment() !== undefined;

/** Make the applied audit insert of one operation fail, until the returned undo runs. */
async function failAppliedAudit(
  world: AgentWorld,
  operationId: string,
): Promise<() => Promise<void>> {
  // A generated UUID only: nothing a caller sent is put into this DDL.
  if (!/^[0-9a-f-]{36}$/u.test(operationId)) throw new Error('needs a generated operation id');
  await world.db.admin.execute(`create function public.p20_fail_audit() returns trigger
    language plpgsql as $$ begin raise exception 'P20_AUDIT_FAILURE'; end $$`);
  await world.db.admin.execute(`create trigger p20_fail_audit before insert on public.audit_events
    for each row when (new.operation_id = '${operationId}' and new.outcome = 'applied')
    execute function public.p20_fail_audit()`);
  return async () => {
    await world.db.admin.execute('drop trigger p20_fail_audit on public.audit_events');
    await world.db.admin.execute('drop function public.p20_fail_audit()');
  };
}

// eslint-disable-next-line max-lines-per-function -- one world, its one retry case
describe.skipIf(!configured)('P20 field names roll back and retry with their change', () => {
  let world: AgentWorld;
  let writer: Decider;

  beforeAll(async () => {
    world = await agentWorld('p20_retry', 'p20-retry');
    writer = await world.decider('p20-retry-writer');
  }, 90_000);
  afterAll(async () => {
    await world?.drop();
  });

  // eslint-disable-next-line max-lines-per-function -- the failure, retry, replay and revoked replay in order
  it('a failed audit write keeps nothing; the retry, replay and revoked replay record the names once', async () => {
    const task = made(
      await world.asPerson(writer, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'before' },
      }),
    );
    const request = update(task, { title: 'after' });
    const before = await taskRow(world.db.admin, task.recordId);

    const undo = await failAppliedAudit(world, request.operationId);
    try {
      await expect(world.asPerson(writer, request)).rejects.toThrow('P20_AUDIT_FAILURE');
    } finally {
      await undo();
    }
    expect(await taskRow(world.db.admin, task.recordId)).toStrictEqual(before);
    expect(await operationsOf(world.db.admin, request.operationId)).toBe(0);
    const failed = await eventsOf(world.db.admin, [request.operationId]);
    expect(failed.map((e) => [e.outcome, e.field_changes])).toStrictEqual([['failed', null]]);

    const applied = await world.asPerson(writer, request);
    expect(applied).toHaveProperty('detail.changed', ['title']);
    const after = await taskRow(world.db.admin, task.recordId);
    expect(await world.asPerson(writer, request)).toStrictEqual(applied);
    expect(await taskRow(world.db.admin, task.recordId)).toStrictEqual(after);

    await world.revokeGrant(writer.grants.write);
    expect(await world.asPerson(writer, request)).toMatchObject({ refused: true });
    expect(await taskRow(world.db.admin, task.recordId)).toStrictEqual(after);

    expect(await operationsOf(world.db.admin, request.operationId)).toBe(1);
    const events = await eventsOf(world.db.admin, [request.operationId]);
    expect(
      events.filter((e) => e.field_changes !== null).map((e) => [e.outcome, e.field_changes]),
    ).toStrictEqual([['applied', { version: 1, keys: ['title'] }]]);
    expect(events.map((e) => e.outcome)).toStrictEqual([
      'failed',
      'applied',
      'replayed',
      'refused',
    ]);
    expect(await world.db.app.withBusiness(world.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });
});
