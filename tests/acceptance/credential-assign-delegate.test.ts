// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #420: an agent credential (API-2) reaches the agent-reachable task
// rows through the person's handlers, as its agent. It is held to what a
// delegated agent writes there: the assignee and not the delegate
// (`AGENT_ASSIGN_FIELDS`), the agent's update fields (`AGENT_UPDATE_FIELDS`),
// and team-only comments (`AGENT_AUDIENCES`). The first case is the review's
// proof (OW-055.1), renamed for what it proves and otherwise as written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
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

/** A task Ada made, and an agent credential of hers holding `task:<action>`. */
async function taskAndCredential(action: string) {
  const made = await as(world.ada, 'task.create', {
    operationId: randomUUID(),
    fields: { title: `Credential ${action} boundary` },
  });
  const issued = await as(world.ada, 'credential.issue', {
    operationId: randomUUID(),
    scope: [{ collection: 'task', action }],
    purpose: `credential ${action} proof`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const credential = (issued.body['detail'] as { readonly credential?: unknown } | undefined)
    ?.credential;
  if (typeof credential !== 'string') throw new Error('credential missing');
  const recordId = String(made.body['recordId']);
  const asAgent = (name: CommandName, body: Record<string, unknown>) =>
    call(
      world.api,
      agentPath('alpha', pathOf(name)),
      { operationId: randomUUID(), recordId, expectedRevision: made.body['revision'], ...body },
      bearer(credential),
    );
  return { recordId, asAgent };
}

it('an agent credential cannot update a field outside the agent update fields', async () => {
  const { recordId, asAgent } = await taskAndCredential('write');
  const outside = await asAgent('task.update', { fields: { priority: 3 } });
  const inside = await asAgent('task.update', { fields: { title: 'Renamed by the agent' } });
  const [row] = await world.db.admin.execute<{ priority: string | null; title: string }>(
    "select data ->> 'priority' as priority, data ->> 'title' as title from public.records where id = $1",
    [recordId],
  );
  expect({ outside: outside.body['code'], inside: inside.status, row }).toEqual({
    outside: 'SCOPE_NOT_GRANTED',
    inside: 200,
    row: { priority: null, title: 'Renamed by the agent' },
  });
});

it('an agent credential cannot write a comment to the client', async () => {
  const { recordId, asAgent } = await taskAndCredential('comment');
  const toClient = await asAgent('task.comment', { body: 'to the client', audience: 'client' });
  const note = await asAgent('task.comment', { body: 'a team note', audience: 'internal' });
  const rows = await world.db.admin.execute<{ audience: string }>(
    "select data ->> 'audience' as audience from public.records where data ->> 'task' = $1",
    [recordId],
  );
  expect({ toClient: toClient.body['code'], note: note.status, rows }).toEqual({
    toClient: 'AUDIENCE_NOT_PERMITTED',
    note: 200,
    rows: [{ audience: 'internal' }],
  });
});
