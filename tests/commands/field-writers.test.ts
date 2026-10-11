// SPDX-License-Identifier: AGPL-3.0-only
//
// P21 (U115): every command that owns a task field records, on its applied
// audit event, the names of the fields its write actually changed, and `[]`
// for a write that changed nothing. One case per command in `FIELD_WRITES`;
// the list, these cases and the audit column's constraint must name the same
// commands, so a writer added to one and not the others fails here.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';
import { addClient, grantTo } from './fixture.ts';
import { eventsOf, made, type Made } from './field-changes-world.ts';
import { FIELD_WRITES } from '../../packages/core-commands/src/commands/outcome.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const configured = databaseUrlFromEnvironment() !== undefined;
const DUE = '2026-11-01T00:00:00.000Z';

type Body = Readonly<Record<string, unknown>>;
/** The write to send, and the field names it should record. */
interface Write {
  readonly body: Body;
  readonly keys: readonly string[];
}
interface Case {
  /** A write that changes something (or, for a command that writes no field, the write itself). */
  readonly change: () => Promise<Write>;
  /** The same command sent with what is already stored, where the command allows it. */
  readonly noop?: () => Promise<Body>;
}

let world: AgentWorld;
let writer: Decider;
let client: string;

const send = async (body: Body) => await world.asPerson(writer, body);
const fresh = async (operands: Body = {}) =>
  made(
    await send({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'P21 writer' },
      ...operands,
    }),
  );
const on = (task: Made, command: string, operands: Body = {}): Body => ({
  command,
  operationId: randomUUID(),
  recordId: task.recordId,
  expectedRevision: task.revision,
  ...operands,
});
const after = async (body: Body) => made(await send(body));
const stateId = async (key: string) => {
  const spine = await world.db.app.withBusiness(world.business, readTaskSpine);
  const found = spine.states.find((one) => one.key === key);
  if (found === undefined) throw new Error(`no state ${key}`);
  return found.id;
};
/** A task with a lineage proposed on it, for the work controls. */
const proposed = async () => {
  const task = await fresh();
  const answer = await send({
    ...on(task, 'task.propose'),
    purpose: `p21_${randomUUID().slice(0, 8)}`,
    maximumMinor: 1_000,
    currency: 'AUD',
    payload: { instruction: 'P21 work' },
    step: { kind: 'compose', payload: {} },
  });
  if (isCommandRefusal(answer)) throw new Error(`propose refused ${answer.code}`);
  return { task, lineageId: String((answer.detail as Body)['lineageId']) };
};
/** A work control's body: it names the task and lineage, and no revision. */
const control = (task: Made, command: string, lineageId: string, operands: Body = {}): Body => ({
  command,
  operationId: randomUUID(),
  recordId: task.recordId,
  lineageId,
  ...operands,
});
const cancelled = async () => {
  const { task, lineageId } = await proposed();
  await send(control(task, 'task.cancel', lineageId, { reason: 'P21 stop' }));
  return { task, lineageId };
};
const ticket = async () => {
  const map = await fresh({ taskType: 'map' });
  return await fresh({ parentId: map.recordId, taskType: 'research' });
};
/** A ticket blocked by another ticket of its map. */
const blocking = async () => {
  const map = await fresh({ taskType: 'map' });
  const blocker = await fresh({ parentId: map.recordId, taskType: 'research' });
  const blocked = await fresh({ parentId: map.recordId, taskType: 'research' });
  return { body: on(blocked, 'task.set_blocking', { blockedBy: [blocker.recordId] }) };
};
/** One owned field, changed and then sent again with the value it now holds. */
const owned = (command: string, fields: () => Body, keys: readonly string[]): Case => ({
  change: async () => ({ body: on(await fresh(), command, { fields: fields() }), keys }),
  noop: async () => {
    const task = await after(on(await fresh(), command, { fields: fields() }));
    return on(task, command, { fields: fields() });
  },
});

const CASES: Readonly<Record<string, Case>> = {
  'task.update': owned('task.update', () => ({ due: DUE }), ['due']),
  'task.assign': owned('task.assign', () => ({ assignee: writer.personId }), ['assignee']),
  'task.set_stage': owned('task.set_stage', () => ({ stage: 'awareness' }), ['stage']),
  'task.set_party': owned('task.set_party', () => ({ client }), ['client']),
  'task.set_scores': owned('task.set_scores', () => ({ impact: 7 }), ['impact']),
  'task.set_adhoc': owned('task.set_adhoc', () => ({ ad_hoc: true }), ['ad_hoc']),
  'task.set_category': owned('task.set_category', () => ({ category: 'admin' }), ['category']),
  'task.triage': owned('task.triage', () => ({ intake_state: 'accepted' }), ['intake_state']),
  'task.set_audience': owned('task.set_audience', () => ({ client_visible: true }), [
    'client_visible',
  ]),
  'map.scope': {
    change: async () => ({
      body: on(await fresh({ taskType: 'map' }), 'map.scope', { client }),
      keys: ['client'],
    }),
    noop: async () => on(await fresh({ taskType: 'map' }), 'map.scope', { client: null }),
  },
  'task.start': {
    change: async () => ({ body: on(await fresh(), 'task.start'), keys: ['started_at', 'state'] }),
  },
  'task.complete': {
    change: async () => ({
      body: on(await fresh({ stateKey: 'active' }), 'task.complete'),
      keys: ['completed_at', 'state'],
    }),
  },
  'task.reopen': {
    change: async () => {
      const done = await after(on(await fresh({ stateKey: 'active' }), 'task.complete'));
      return {
        body: on(done, 'task.reopen', { reason: 'P21 again' }),
        keys: ['completed_at', 'state'],
      };
    },
  },
  'task.set_state': {
    change: async () => ({
      body: on(await fresh(), 'task.set_state', { stateId: await stateId('active') }),
      keys: ['started_at', 'state'],
    }),
  },
  'task.cancel': {
    change: async () => {
      const { task, lineageId } = await proposed();
      return { body: control(task, 'task.cancel', lineageId, { reason: 'P21 stop' }), keys: [] };
    },
  },
  'task.restart': {
    change: async () => {
      const { task, lineageId } = await cancelled();
      return { body: control(task, 'task.restart', lineageId), keys: [] };
    },
  },
  'task.move': {
    change: async () => {
      const board = await fresh();
      return {
        body: on(await fresh(), 'task.move', { board: board.recordId }),
        keys: ['board', 'board_rank'],
      };
    },
    noop: async () => {
      const board = await fresh();
      return on(await fresh({ board: board.recordId }), 'task.move', { board: board.recordId });
    },
  },
  'task.reparent': {
    change: async () => {
      const parent = await fresh();
      return {
        body: on(await fresh(), 'task.reparent', { parentId: parent.recordId }),
        keys: ['board_rank', 'parent'],
      };
    },
  },
  'task.rank': {
    change: async () => {
      const board = await fresh();
      const first = await fresh({ board: board.recordId });
      return {
        body: on(await fresh({ board: board.recordId }), 'task.rank', { beforeId: first.recordId }),
        keys: ['board_rank'],
      };
    },
  },
  'task.set_type': {
    change: async () => ({
      body: on(await fresh(), 'task.set_type', { taskType: 'research' }),
      keys: ['type', 'type_history'],
    }),
  },
  'task.claim': {
    change: async () => ({ body: on(await ticket(), 'task.claim'), keys: ['assignee'] }),
  },
  'task.set_blocking': {
    change: async () => ({ ...(await blocking()), keys: ['blocked_by'] }),
    noop: async () => {
      const { body } = await blocking();
      const task = await after(body);
      return on(task, 'task.set_blocking', { blockedBy: body['blockedBy'] });
    },
  },
  'task.resolve': {
    change: async () => ({
      body: on(await ticket(), 'task.resolve', { answer: 'P21 answer', gist: 'P21 gist' }),
      keys: ['answer', 'completed_at', 'gist', 'state'],
    }),
  },
  'task.close_out_of_scope': {
    change: async () => ({
      body: on(await ticket(), 'task.close_out_of_scope', { reason: 'P21 elsewhere' }),
      keys: ['closed_as', 'completed_at', 'state'],
    }),
  },
};

/** The field names the applied event of this write recorded, or the refusal code. */
async function recorded(body: Body): Promise<unknown> {
  const answer = await send(body);
  if (isCommandRefusal(answer)) return answer.code;
  const events = await eventsOf(world.db.admin, [String(body['operationId'])]);
  return events.map((event) => [event.outcome, event.command, event.field_changes]);
}

// eslint-disable-next-line max-lines-per-function -- one world, a case per field writer
describe.skipIf(!configured)('P21 every task field writer records what it changed', () => {
  beforeAll(async () => {
    world = await agentWorld('p21_writers', 'p21-writers');
    writer = await world.decider('p21-writer');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, writer, 'assign');
      await grantTo(tx, writer, 'share');
    });
    client = randomUUID();
    await addClient(world.db.app, world.business, client, writer);
  }, 90_000);
  afterAll(async () => {
    await world?.drop();
  });

  it('the cases, FIELD_WRITES and the audit column constraint name the same commands', async () => {
    const rows = await world.db.admin.execute<{ readonly definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'audit_events_field_changes_supported'`,
    );
    const listed = /ARRAY\[(?<names>[^\]]*)\]/u.exec(rows[0]?.definition ?? '')?.groups?.['names'];
    const allowed = [...(listed ?? '').matchAll(/'(?<name>[a-z_.]+)'/gu)].map(
      (match) => match.groups?.['name'],
    );
    expect(allowed.toSorted()).toStrictEqual([...FIELD_WRITES].toSorted());
    expect(Object.keys(CASES).toSorted()).toStrictEqual([...FIELD_WRITES].toSorted());
  });

  it.each([...FIELD_WRITES])('%s records exactly the fields it changed', async (command) => {
    const write = await CASES[command]?.change();
    if (write === undefined) throw new Error(`no case for ${command}`);
    expect(await recorded(write.body)).toStrictEqual([
      ['applied', command, { version: 1, keys: write.keys }],
    ]);
  });

  it.each(
    Object.entries(CASES).flatMap(([command, one]) => (one.noop ? [[command, one.noop]] : [])),
  )('%s sent with what is stored records []', async (command, noop) => {
    const body = await (noop as () => Promise<Body>)();
    expect(await recorded(body)).toStrictEqual([['applied', command, { version: 1, keys: [] }]]);
  });
});
