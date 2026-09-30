// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 isolation, the agent's reach: `live correction requested` inside a
// delegation (the permissions table: run:write, an agent may hold it inside
// its delegation). The delegation is the one a task pickup mints (MP-6-2's run
// reach): it carries `run`, held to `write`, only where the approving person
// holds run:write at the pickup, and a pickup approved by a person without it
// reaches nothing here. Under that reach the request stays on its own task, in
// its own business, and at the parties the delegating person's live grant
// covers; the delegating person is the requester, so they cannot approve it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { grantTo } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 agent request: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

const body = (partyId: string, taskId: string) => ({
  ...requestBody(partyId, taskId),
  operationId: randomUUID(),
});

const agentRows = async () =>
  (
    await w.world.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.live_corrections where requested_by_actor_id = $1',
      [w.world.agentActorId],
    )
  )[0]?.n;

/** The collections and actions of every delegation minted for `personId`. */
const delegationsFor = async (personId: string) =>
  await w.world.db.admin.execute<{ readonly collections: string[]; readonly actions: string[] }>(
    'select collections, actions from public.delegations where delegate_person_id = $1',
    [personId],
  );

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('c80agent');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C80 agent request under a pickup’s run reach', () => {
  it('is made under the delegation a pickup minted for a person who holds run:write', async () => {
    const picked = await w.world.pickUp(w.ava, 'the about page');
    const asked = await w.world.asAgent(body(w.partyA, picked.taskId), picked.credential);
    expect(codeOf(asked)).toBe('not-a-refusal');
    const stored = await w.world.db.admin.execute<{
      readonly state: string;
      readonly actor: string;
      readonly person: string;
      readonly delegate: string;
      readonly collections: string[];
    }>(
      `select c.state, c.requested_by_actor_id as actor, c.requested_by_person_id as person,
              d.delegate_person_id as delegate, d.collections
         from public.live_corrections c
         join public.delegations d on d.business_id = c.business_id and d.id = c.delegation_id
        where c.id = $1`,
      [String(detailOf(asked)['correctionId'])],
    );
    expect(stored).toEqual([
      {
        state: 'requested',
        actor: w.world.agentActorId,
        person: w.ava.personId,
        delegate: w.ava.personId,
        collections: ['task', 'run'],
      },
    ]);
  });

  it('gets no run reach where the approving person lacks run:write', async () => {
    const before = await agentRows();
    const gus = await w.world.decider('gus');
    const picked = await w.world.pickUp(gus, 'task work only');
    expect((await delegationsFor(gus.personId)).map((row) => row.collections)).toStrictEqual([
      ['task'],
    ]);
    const asked = await w.world.asAgent(body(w.partyA, picked.taskId), picked.credential);
    expect(codeOf(asked)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await agentRows()).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)('C80 agent request, crossings under a run reach', () => {
  it('another task of the same person is outside the purpose', async () => {
    const before = await agentRows();
    const picked = await w.world.pickUp(w.ava, 'one task');
    const asked = await w.world.asAgent(body(w.partyA, w.taskA), picked.credential);
    expect(codeOf(asked)).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await agentRows()).toBe(before);
  });

  it('another business’s task is outside the purpose, and that business holds nothing', async () => {
    const before = await agentRows();
    const theirs = await w.asIn(w.beta, w.eve, { command: 'task.create', fields: { title: 'x' } });
    const betaTask = 'recordId' in theirs ? String(theirs.recordId) : '';
    const picked = await w.world.pickUp(w.ava, 'one business');
    const asked = await w.world.asAgent(body(w.partyA, betaTask), picked.credential);
    expect(codeOf(asked)).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await agentRows()).toBe(before);
    const beta = await w.world.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.live_corrections where business_id = $1',
      [w.beta],
    );
    expect(beta[0]?.n).toBe('0');
  });
});

describe.skipIf(serverUrl === undefined)('C80 agent request, parties under a run reach', () => {
  it('reaches only the client parties the delegating person’s live grant covers', async () => {
    // Picked up while the person holds run:write business-wide (the pickup
    // mints run only then), then narrowed to party B: the delegation stays
    // live, and the person's live grant, read at the request, covers B only.
    const before = Number(await agentRows());
    const fay = await w.world.decider('fay');
    const writeGrant = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, fay, 'read', { kind: 'business', id: null }, false, 'run');
      return await grantTo(tx, fay, 'write', { kind: 'business', id: null }, false, 'run');
    });
    const picked = await w.world.pickUp(fay, 'a client’s page');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await revokeGrant(tx, writeGrant);
      await grantTo(tx, fay, 'write', { kind: 'party', id: w.partyB }, false, 'run');
    });
    const onA = await w.world.asAgent(body(w.partyA, picked.taskId), picked.credential);
    expect(codeOf(onA)).toBe('SCOPE_NOT_GRANTED');
    expect(await agentRows()).toBe(String(before));
    const onB = await w.world.asAgent(body(w.partyB, picked.taskId), picked.credential);
    expect(codeOf(onB)).toBe('not-a-refusal');
    expect(await agentRows()).toBe(String(before + 1));
  });

  it('records the delegating person as the requester, who then cannot approve it', async () => {
    await w.setApprover(w.ava.personId);
    const picked = await w.world.pickUp(w.ava, 'approved by another');
    const asked = detailOf(await w.world.asAgent(body(w.partyA, picked.taskId), picked.credential));
    const id = String(asked['correctionId']);
    const approve = await w.approve(w.ava, id, String(asked['versionId']));
    expect(codeOf(approve)).toBe('SELF_APPROVAL_REFUSED');
    expect(await w.stateOf(id)).toBe('requested');
    await w.setApprover(w.ben.personId);
    expect(codeOf(await w.approve(w.ben, id, String(asked['versionId'])))).toBe('not-a-refusal');
  });
});
