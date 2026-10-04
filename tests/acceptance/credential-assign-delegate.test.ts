// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #420: an agent credential (API-2) reaches `task.assign` because
// the row is agent-reachable, and runs the person's handler there; it is held
// to what a delegated agent may set (`AGENT_ASSIGN_FIELDS`, the assignee),
// never the delegate. The case is the review's proof (OW-055.1), renamed for
// what it proves and otherwise as written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import {
  createWorld,
  call,
  bearer,
  personPath,
  agentPath,
  type World,
  type Caller,
} from './world.ts';

describe('agent credential on task.assign', () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld('credential_assign');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  const as = (who: Caller, name: CommandName, body: Record<string, unknown> = {}) =>
    call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

  it('an API-2 agent credential cannot write the delegate field through task.assign', async () => {
    const made = await as(world.ada, 'task.create', {
      operationId: randomUUID(),
      fields: { title: 'Agent assignment boundary' },
    });
    expect(made.status).toBe(200);
    const issued = await as(world.ada, 'credential.issue', {
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'assign' }],
      purpose: 'Sol assignment proof',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(issued.status).toBe(200);
    const detail = issued.body['detail'];
    if (
      typeof detail !== 'object' ||
      detail === null ||
      !('credential' in detail) ||
      typeof detail.credential !== 'string'
    )
      throw new Error('credential missing');
    const assigned = await call(
      world.api,
      agentPath('alpha', pathOf('task.assign')),
      {
        operationId: randomUUID(),
        recordId: made.body['recordId'],
        expectedRevision: made.body['revision'],
        fields: { delegate: world.mia.personId },
      },
      bearer(detail.credential),
    );
    const stored = await world.db.admin.execute<{ delegate: string | null }>(
      "select data ->> 'delegate' as delegate from public.records where id = $1",
      [made.body['recordId']],
    );
    expect({ refused: assigned.body['refused'] === true, delegate: stored[0]?.delegate }).toEqual({
      refused: true,
      delegate: null,
    });
  });
});
