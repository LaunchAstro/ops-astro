// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one world, the history cases on it in order */
//
// U116 (P22): a task's history names the fields each change set, from its own
// audit event, and holds the changes only. The command writes, the audit
// event records, and `task.read` projects; nothing else stores history. One
// entry is looked up by its event id in the same projection.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, detailOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { made, update } from '../commands/field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  writeAuditEvent,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { HistoryEntry } from '../../packages/core-wire/src/index.ts';
import type { FieldChanges } from '../../packages/core-commands/src/commands/outcome.ts';

const configured = databaseUrlFromEnvironment() !== undefined;
const DUE = '2026-11-01T00:00:00.000Z';
const DIGEST = '0'.repeat(64);

type Body = Readonly<Record<string, unknown>>;

describe.skipIf(!configured)('U116 task history names the fields a change set', () => {
  let world: AgentWorld;
  let mia: Decider;

  beforeAll(async () => {
    world = await agentWorld('u116_fields', 'u116-fields');
    mia = await world.decider('Mia');
  }, 120_000);
  afterAll(async () => {
    await world?.drop();
  });

  const read = async (recordId: string, extra: Body = {}) =>
    await executeRead(world.db.app, world.business, mia.presented, {
      read: 'task.read',
      recordId,
      ...extra,
    } as never);

  const historyOf = async (recordId: string): Promise<readonly HistoryEntry[]> => {
    const answer = await read(recordId);
    if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
    return answer.task.history;
  };

  const create = async (fields: Body) =>
    made(await world.asPerson(mia, { command: 'task.create', operationId: randomUUID(), fields }));

  /** An applied event written as the envelope writes one, with the field names given or none. */
  const recorded = async (recordId: string, fieldChanges?: FieldChanges) =>
    await world.db.app.withBusiness(world.business, async (tx) => {
      const written = await writeAuditEvent(tx, {
        actorId: mia.actorId,
        command: 'task.update',
        operationId: randomUUID(),
        outcome: 'applied',
        subjectRecordId: recordId,
        payloadDigest: DIGEST,
        ...(fieldChanges === undefined ? {} : { fieldChanges }),
      });
      return written.id;
    });

  it('Core 10b 1: a due date and priority change is named, with who made it', async () => {
    const task = await create({ title: 'history fields' });
    const request = update(task, { due: DUE, priority: 3 });
    expect(isCommandRefusal(await world.asPerson(mia, request))).toBe(false);
    const latest = (await historyOf(task.recordId)).at(-1);
    expect(latest).toMatchObject({
      operation: 'task.update',
      changed: ['due', 'priority'],
      actorName: 'Mia',
      actorId: mia.actorId,
      personId: mia.personId,
    });
    // The entry is the audit event itself, by its id: no second history store.
    const events = await world.db.admin.execute<{ readonly id: string }>(
      'select id::text from public.audit_events where operation_id = $1',
      [request.operationId],
    );
    expect(latest?.eventId).toBe(events[0]?.id);
    expect(JSON.stringify(latest)).not.toContain(DUE);
  });

  it('Core 10b 2: an event recorded before field names existed reads as a change, unnamed', async () => {
    const task = await create({ title: 'legacy' });
    const legacy = await recorded(task.recordId);
    const entry = (await historyOf(task.recordId)).find((one) => one.eventId === legacy);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('changed');
    expect(entry?.operation).toBe('task.update');
  });

  it('Core 10b 2: a write that changed nothing is not a change, and a read adds none', async () => {
    const task = await create({ title: 'same' });
    const before = await historyOf(task.recordId);
    expect(isCommandRefusal(await world.asPerson(mia, update(task, { title: 'same' })))).toBe(
      false,
    );
    await historyOf(task.recordId);
    expect(await historyOf(task.recordId)).toStrictEqual(before);
  });

  it('Core 10b 1: a field no history names, a custom one included, is never sent', async () => {
    const task = await create({ title: 'custom' });
    const id = await recorded(task.recordId, { version: 1, keys: ['due', 'secret_custom'] });
    const entry = (await historyOf(task.recordId)).find((one) => one.eventId === id);
    expect(entry?.changed).toStrictEqual(['due']);
    expect(JSON.stringify(entry)).not.toContain('secret_custom');
  });

  it('Core 10b 3: comments and their edits are not in the history', async () => {
    const task = await create({ title: 'talk' });
    const before = await historyOf(task.recordId);
    const comment = await world.asPerson(mia, {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: task.recordId,
      expectedRevision: task.revision,
      body: 'a note, not a change',
      audience: 'internal',
    });
    expect(isCommandRefusal(comment)).toBe(false);
    expect(await historyOf(task.recordId)).toStrictEqual(before);
  });

  it('a former member is not named, and the change still shows', async () => {
    const leaver = await world.decider('Leaver');
    const task = made(
      await world.asPerson(leaver, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'left behind' },
      }),
    );
    await world.db.admin.execute(
      `update public.memberships set active = false, ended_at = now() where person_id = $1`,
      [leaver.personId],
    );
    const [created] = await historyOf(task.recordId);
    expect(created).toMatchObject({
      operation: 'task.create',
      actorId: null,
      personId: null,
      actorName: null,
      actorKind: 'person',
    });
  });

  it('Core 10b 5: direct lookup finds an entry of this task’s history and nothing else', async () => {
    const task = await create({ title: 'lookup' });
    const other = await create({ title: 'another task' });
    const request = update(task, { title: 'lookup renamed' });
    await world.asPerson(mia, request);
    const entry = (await historyOf(task.recordId)).at(-1);
    const eventId = entry?.eventId ?? '';
    const found = await read(task.recordId, { historyEventId: eventId.toUpperCase() });
    expect(found).toHaveProperty('task.historyEvent', entry);
    const full = await read(task.recordId, { historyEventId: eventId, detail: 'full' });
    expect(full).toHaveProperty('view.historyEvent', entry);
    // Another task's event, a comment's, and an id nobody holds: one answer.
    const comment = await world.asPerson(mia, {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: task.recordId,
      expectedRevision: task.revision + 1,
      body: 'looked up',
      audience: 'internal',
    });
    const commentEvent = await world.db.admin.execute<{ readonly id: string }>(
      `select id::text from public.audit_events where command = 'task.comment'
        and subject_record_id = $1 and outcome = 'applied'`,
      [task.recordId],
    );
    expect(isCommandRefusal(comment)).toBe(false);
    const otherEvent = (await historyOf(other.recordId)).at(-1)?.eventId ?? '';
    for (const id of [otherEvent, commentEvent[0]?.id ?? '', randomUUID()]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await read(task.recordId, { historyEventId: id })).toHaveProperty(
        'task.historyEvent',
        null,
      );
    }
  });

  it('direct lookup refuses a malformed id, and a level that carries no history', async () => {
    const task = await create({ title: 'refusals' });
    for (const extra of [
      { historyEventId: 'not-an-id' },
      { historyEventId: 7 },
      { historyEventId: randomUUID(), detail: 'brief' },
      { historyEventId: randomUUID(), detail: 'standard' },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await read(task.recordId, extra)).toMatchObject({
        refused: true,
        code: 'FIELD_VALUE_INVALID',
        names: ['historyEventId'],
      });
    }
  });

  it('Core 10b 3: an agent is told no rank mark changed, and looks up its own task’s entries', async () => {
    const decider = await world.decider('agent-decider');
    const picked = await world.pickUp(decider, 'the agent’s task');
    const id = await recorded(picked.taskId, { version: 1, keys: ['due', 'impact'] });
    const asAgent = async (extra: Body) =>
      detailOf(
        await world.asAgent(
          { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId, ...extra },
          picked.credential,
        ),
      )['task'] as { readonly history: readonly HistoryEntry[]; readonly historyEvent?: unknown };
    const own = await asAgent({ historyEventId: id });
    const entry = own.history.find((one) => one.eventId === id);
    expect(entry).toMatchObject({ changed: ['due'], personId: null, actorName: null });
    expect(own.historyEvent).toStrictEqual(entry);
    const staff = (await historyOf(picked.taskId)).find((one) => one.eventId === id);
    expect(staff?.changed).toStrictEqual(['due', 'impact']);
    const refused = await world.asAgent(
      {
        command: 'task.read',
        operationId: randomUUID(),
        recordId: picked.taskId,
        historyEventId: id,
        detail: 'brief',
      },
      picked.credential,
    );
    expect(refused).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['historyEventId'] });
  });

  it('the audit chain still verifies', async () => {
    expect(await world.db.app.withBusiness(world.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });
});
