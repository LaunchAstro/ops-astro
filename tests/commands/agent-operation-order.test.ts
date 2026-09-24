// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent route's refusal code, and its audit trail, for every agent
// operation under every credential it can arrive with, pinned before the
// agent envelope was split into per-operation rows (thermo H1). The order the
// envelope asks its questions in is what the table shows: the surface, the
// operation identity, the register, the request's own shape, the authority,
// then the operation. Nothing here asserts a behaviour the other agent suites
// do not; it holds all of them to one table so a move that reordered a check
// shows up as a changed row.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  agentWorld,
  codeOf,
  type AgentWorld,
  type Decider,
  type PickedUp,
} from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'commands/agent-operation-order: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

/** The body each operation is sent with, against the task and lease named. */
function bodyOf(command: string, picked: PickedUp): Body {
  const leaseId = String(picked.detail['leaseId']);
  const fence = Number(picked.detail['fence']);
  switch (command) {
    case 'task.pickup':
      return { command, reservationId: randomUUID() };
    case 'task.handback':
      return { command, leaseId, fence, outcome: 'completed' };
    case 'task.heartbeat':
      return { command, leaseId, fence };
    case 'task.read':
      return { command, recordId: picked.taskId };
    case 'task.comment':
      return { command, recordId: picked.taskId, body: 'a note', audience: 'internal' };
    case 'task.decide':
      return { command, gateId: randomUUID(), versionId: randomUUID(), decision: 'approve' };
    default:
      return { command };
  }
}

const COMMANDS = [
  'task.queue',
  'task.pickup',
  'task.handback',
  'task.heartbeat',
  'task.read',
  'task.comment',
  'task.decide',
  'session.capabilities',
  'task.create',
  'task.nothing',
] as const;

type Row = readonly [code: string, audit: string];

/** The table as the envelope answered it at faf3285, before the split. */
const EXPECTED: Record<string, Record<string, Row>> = {
  'task.queue': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': ['not-a-refusal', 'applied:-'],
    'report a list, no credential': ['not-a-refusal', 'applied:-'],
    'actualMinor 1, no credential': ['not-a-refusal', 'applied:-'],
    'no credential': ['not-a-refusal', 'applied:-'],
    'unknown credential': ['not-a-refusal', 'applied:-'],
    'sibling task': ['not-a-refusal', 'applied:-'],
    'own credential': ['not-a-refusal', 'applied:-'],
    replayed: ['not-a-refusal', 'applied:-,replayed:-'],
    'replayed without credential': ['not-a-refusal', 'applied:-,replayed:-,replayed:-'],
    'replayed, body changed': ['OPERATION_ID_REUSED', 'applied:-,replayed:-,replayed:-'],
    'after, own credential': ['not-a-refusal', 'applied:-'],
  },
  'task.pickup': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': ['FIELD_VALUE_INVALID', 'refused:FIELD_VALUE_INVALID'],
    'report a list, no credential': [
      'RESERVATION_NOT_CLAIMABLE',
      'refused:RESERVATION_NOT_CLAIMABLE',
    ],
    'actualMinor 1, no credential': [
      'RESERVATION_NOT_CLAIMABLE',
      'refused:RESERVATION_NOT_CLAIMABLE',
    ],
    'no credential': ['RESERVATION_NOT_CLAIMABLE', 'refused:RESERVATION_NOT_CLAIMABLE'],
    'unknown credential': ['RESERVATION_NOT_CLAIMABLE', 'refused:RESERVATION_NOT_CLAIMABLE'],
    'sibling task': ['RESERVATION_NOT_CLAIMABLE', 'refused:RESERVATION_NOT_CLAIMABLE'],
    'own credential': ['RESERVATION_NOT_CLAIMABLE', 'refused:RESERVATION_NOT_CLAIMABLE'],
    replayed: [
      'RESERVATION_NOT_CLAIMABLE',
      'refused:RESERVATION_NOT_CLAIMABLE,replayed:RESERVATION_NOT_CLAIMABLE',
    ],
    'replayed without credential': [
      'RESERVATION_NOT_CLAIMABLE',
      'refused:RESERVATION_NOT_CLAIMABLE,replayed:RESERVATION_NOT_CLAIMABLE,replayed:RESERVATION_NOT_CLAIMABLE',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'refused:RESERVATION_NOT_CLAIMABLE,replayed:RESERVATION_NOT_CLAIMABLE,replayed:RESERVATION_NOT_CLAIMABLE',
    ],
    'after, own credential': ['RESERVATION_NOT_CLAIMABLE', 'refused:RESERVATION_NOT_CLAIMABLE'],
  },
  'task.handback': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'report a list, no credential': ['FIELD_VALUE_INVALID', 'refused:FIELD_VALUE_INVALID'],
    'actualMinor 1, no credential': [
      'ACTUAL_EXPENDITURE_UNSUPPORTED',
      'refused:ACTUAL_EXPENDITURE_UNSUPPORTED',
    ],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', 'refused:DELEGATION_EXCLUDES_OPERATION'],
    'unknown credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
    'sibling task': ['DELEGATION_OUT_OF_PURPOSE', 'refused:DELEGATION_OUT_OF_PURPOSE'],
    'own credential': ['not-a-refusal', 'applied:-'],
    replayed: ['not-a-refusal', 'applied:-,replayed:-'],
    'replayed without credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'after, own credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
  },
  'task.heartbeat': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': ['FIELD_VALUE_INVALID', 'refused:FIELD_VALUE_INVALID'],
    'report a list, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'actualMinor 1, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', 'refused:DELEGATION_EXCLUDES_OPERATION'],
    'unknown credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
    'sibling task': ['DELEGATION_OUT_OF_PURPOSE', 'refused:DELEGATION_OUT_OF_PURPOSE'],
    'own credential': ['not-a-refusal', 'applied:-'],
    replayed: ['not-a-refusal', 'applied:-,replayed:-'],
    'replayed without credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'after, own credential': ['not-a-refusal', 'applied:-'],
  },
  'task.read': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'report a list, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'actualMinor 1, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', 'refused:DELEGATION_EXCLUDES_OPERATION'],
    'unknown credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
    'sibling task': ['DELEGATION_OUT_OF_PURPOSE', 'refused:DELEGATION_OUT_OF_PURPOSE'],
    'own credential': ['not-a-refusal', 'applied:-'],
    replayed: ['not-a-refusal', 'applied:-,replayed:-'],
    'replayed without credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'after, own credential': ['not-a-refusal', 'applied:-'],
  },
  'task.comment': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'report a list, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'actualMinor 1, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', 'refused:DELEGATION_EXCLUDES_OPERATION'],
    'unknown credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
    'sibling task': ['DELEGATION_OUT_OF_PURPOSE', 'refused:DELEGATION_OUT_OF_PURPOSE'],
    'own credential': ['not-a-refusal', 'applied:-'],
    replayed: ['not-a-refusal', 'applied:-,replayed:-'],
    'replayed without credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'after, own credential': ['not-a-refusal', 'applied:-'],
  },
  'task.decide': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': [
      'DELEGATION_EXCLUDES_DECISION',
      'refused:DELEGATION_EXCLUDES_DECISION',
    ],
    'report a list, no credential': [
      'DELEGATION_EXCLUDES_DECISION',
      'refused:DELEGATION_EXCLUDES_DECISION',
    ],
    'actualMinor 1, no credential': [
      'DELEGATION_EXCLUDES_DECISION',
      'refused:DELEGATION_EXCLUDES_DECISION',
    ],
    'no credential': ['DELEGATION_EXCLUDES_DECISION', 'refused:DELEGATION_EXCLUDES_DECISION'],
    'unknown credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
    'sibling task': ['DELEGATION_EXCLUDES_DECISION', 'refused:DELEGATION_EXCLUDES_DECISION'],
    'own credential': ['DELEGATION_EXCLUDES_DECISION', 'refused:DELEGATION_EXCLUDES_DECISION'],
    replayed: [
      'DELEGATION_EXCLUDES_DECISION',
      'refused:DELEGATION_EXCLUDES_DECISION,replayed:DELEGATION_EXCLUDES_DECISION',
    ],
    'replayed without credential': [
      'DELEGATION_EXCLUDES_DECISION',
      'refused:DELEGATION_EXCLUDES_DECISION,replayed:DELEGATION_EXCLUDES_DECISION,replayed:DELEGATION_EXCLUDES_DECISION',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'refused:DELEGATION_EXCLUDES_DECISION,replayed:DELEGATION_EXCLUDES_DECISION,replayed:DELEGATION_EXCLUDES_DECISION',
    ],
    'after, own credential': [
      'DELEGATION_EXCLUDES_DECISION',
      'refused:DELEGATION_EXCLUDES_DECISION',
    ],
  },
  'session.capabilities': {
    'operation id absent': ['OPERATION_ID_REQUIRED', ''],
    'operation id a number': ['OPERATION_ID_REQUIRED', ''],
    'system field, no credential': ['FIELD_NOT_WRITABLE', 'refused:FIELD_NOT_WRITABLE'],
    'leaseSeconds 0, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'report a list, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'actualMinor 1, no credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', 'refused:DELEGATION_EXCLUDES_OPERATION'],
    'unknown credential': ['DELEGATION_NOT_LIVE', 'refused:DELEGATION_NOT_LIVE'],
    'sibling task': ['not-a-refusal', 'applied:-'],
    'own credential': ['not-a-refusal', 'applied:-'],
    replayed: ['not-a-refusal', 'applied:-,replayed:-'],
    'replayed without credential': [
      'DELEGATION_EXCLUDES_OPERATION',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'replayed, body changed': [
      'OPERATION_ID_REUSED',
      'applied:-,replayed:-,refused:DELEGATION_EXCLUDES_OPERATION',
    ],
    'after, own credential': ['not-a-refusal', 'applied:-'],
  },
  'task.create': {
    'operation id absent': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'operation id a number': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'system field, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'leaseSeconds 0, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'report a list, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'actualMinor 1, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'unknown credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'sibling task': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'own credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    replayed: ['DELEGATION_EXCLUDES_OPERATION', ''],
    'replayed without credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'replayed, body changed': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'after, own credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
  },
  'task.nothing': {
    'operation id absent': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'operation id a number': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'system field, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'leaseSeconds 0, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'report a list, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'actualMinor 1, no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'no credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'unknown credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'sibling task': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'own credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    replayed: ['DELEGATION_EXCLUDES_OPERATION', ''],
    'replayed without credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'replayed, body changed': ['DELEGATION_EXCLUDES_OPERATION', ''],
    'after, own credential': ['DELEGATION_EXCLUDES_OPERATION', ''],
  },
};

describe.skipIf(serverUrl === undefined)('the agent route, operation by operation', () => {
  let world: AgentWorld;
  let decider: Decider;
  let sibling: PickedUp;

  beforeAll(async () => {
    world = await agentWorld('h', 'agent-operation-order');
    decider = await world.decider('order');
    sibling = await world.pickUp(decider, 'the sibling task');
  });

  afterAll(async () => {
    await world?.drop();
  });

  /** One call, then its code and the audit rows its operation id wrote. */
  async function call(body: Body, credential?: string): Promise<Row> {
    const operationId = typeof body['operationId'] === 'string' ? body['operationId'] : '';
    const result = await world.asAgent(body, credential);
    const audit = operationId === '' ? [] : await world.auditFor(operationId);
    return [codeOf(result), audit.map((row) => `${row.outcome}:${row.code ?? '-'}`).join(',')];
  }

  it('answers each operation in the same order under each credential', async () => {
    const table: Record<string, Record<string, Row>> = {};
    for (const command of COMMANDS) {
      // Sequential: each case reads the rows the one before it wrote.
      // oxlint-disable-next-line no-await-in-loop
      const mine = await world.pickUp(decider, `the ${command} task`);
      const body = bodyOf(command, mine);
      const fresh = (): Body => ({ ...body, operationId: randomUUID() });
      const rows: Record<string, Row> = {};
      /* eslint-disable no-await-in-loop */
      rows['operation id absent'] = await call(body, mine.credential);
      rows['operation id a number'] = await call(
        { ...body, operationId: 12345678 },
        mine.credential,
      );
      rows['system field, no credential'] = await call({ ...fresh(), createdAt: 'now' });
      rows['leaseSeconds 0, no credential'] = await call({ ...fresh(), leaseSeconds: 0 });
      rows['report a list, no credential'] = await call({ ...fresh(), report: [1] });
      rows['actualMinor 1, no credential'] = await call({ ...fresh(), actualMinor: 1 });
      rows['no credential'] = await call(fresh());
      rows['unknown credential'] = await call(fresh(), randomUUID());
      rows['sibling task'] = await call(
        { ...bodyOf(command, sibling), operationId: randomUUID() },
        mine.credential,
      );
      const first = fresh();
      rows['own credential'] = await call(first, mine.credential);
      rows['replayed'] = await call(first, mine.credential);
      rows['replayed without credential'] = await call(first);
      rows['replayed, body changed'] = await call({ ...first, extra: 1 }, mine.credential);
      rows['after, own credential'] = await call(fresh(), mine.credential);
      /* eslint-enable no-await-in-loop */
      table[command] = rows;
    }
    expect(table).toEqual(EXPECTED);
  }, 60_000);
});
