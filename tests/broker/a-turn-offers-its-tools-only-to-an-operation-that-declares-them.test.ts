// SPDX-License-Identifier: AGPL-3.0-only
//
// The tools a turn offers reach a provider only through a field its
// operation declares (#2091): an operation with a `tools` field gets the
// offered catalogue names, in order, beside the bound `turn`, which stays
// first so the turn's class is still read from it. The replay turn declares
// none, so its one field and the bytes it sends are as they were.

import { describe, expect, it } from 'vitest';
import {
  registerModelOperation,
  REPLAY_TURN,
  type ModelOperation,
} from '../../packages/core-connectors/src/index.ts';
import { fieldsOf } from '../../packages/core-custody/src/broker-turn.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';

const TASK = '00000000-0000-4000-8000-000000000001';
const LEASE = '00000000-0000-4000-8000-0000000000b1';

const operationOf = (declared: unknown): ModelOperation => {
  const registration = registerModelOperation(declared);
  if (!registration.ok) throw new Error(registration.faults.join(', '));
  return registration.operation;
};

const WITH_TOOLS = operationOf({
  ...REPLAY_TURN,
  key: 'model.tools_turn',
  fields: { turn: 'business_internal', tools: 'business_internal' },
});

const facts = {
  leaseId: LEASE,
  runId: 'the-run',
  source: {
    id: TASK,
    live: true,
    revision: 3,
    entered: 'person:app',
    othersWrote: false,
    clientTyped: false,
    ownerWork: true,
    data: { title: 'About page hours' },
  },
};

/** A task-only turn binds without a query, so any query is a fault here. */
const tx = {
  query: () => Promise.reject(new Error('no query expected')),
} as unknown as TenantQuery;

const request = (tools: readonly string[]) => ({
  leaseId: LEASE,
  operation: WITH_TOOLS.key,
  fields: [],
  turn: { turnOrdinal: 0, tools, parts: [{ ref: 'task', taskId: TASK, revision: 3 }] },
});

describe('the fields a turn sends', () => {
  it('gives an operation that declares tools the offered names, after the turn', async () => {
    const fields = await fieldsOf(tx, request(['task.read']) as never, WITH_TOOLS, facts);
    expect(fields.ok && fields.fields.map((field) => field.name)).toStrictEqual(['turn', 'tools']);
    expect(fields.ok && fields.fields[1]).toStrictEqual({
      name: 'tools',
      source: 'business_internal',
      value: JSON.stringify(['task.read']),
    });
  });

  it('sends none where the turn offered none, as an empty list', async () => {
    const fields = await fieldsOf(tx, request([]) as never, WITH_TOOLS, facts);
    expect(fields.ok && fields.fields[1]?.value).toBe('[]');
  });

  it('leaves the replay turn its one field', async () => {
    const asked = { ...request(['task.read']), operation: REPLAY_TURN.key };
    const fields = await fieldsOf(tx, asked as never, operationOf(REPLAY_TURN), facts);
    expect(fields.ok && fields.fields.map((field) => field.name)).toStrictEqual(['turn']);
  });
});
