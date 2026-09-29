// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 isolation, the agent's reach: `live correction requested` inside a
// delegation (the permissions table: run:write, an agent may hold it inside
// its delegation). A delegation minted at a task pickup carries the task
// collection only and reaches nothing here; one that carries run:write reaches
// only its own task and the parties its delegating person's live grant covers,
// and the delegating person is the requester, so they cannot approve it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { AFTER, ABOUT, BEFORE, PAGE, c80World, type C80World } from './c80-world.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { grantTo, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 agent request: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

async function mintFor(person: Member, taskId: string): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: person.personId,
      mintedByActorId: person.actorId,
      purpose: `c80_${randomUUID().slice(0, 8)}`,
      collections: ['run'],
      actions: ['read', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

const body = (partyId: string, taskId: string) => ({
  command: 'live_correction.request',
  operationId: randomUUID(),
  partyId,
  taskId,
  path: ABOUT,
  word: 'friendly',
  replacement: 'welcoming',
  pageUrl: PAGE,
  baseRevision: 'rev-1',
  before: BEFORE,
  after: AFTER,
});

const agentRows = async () =>
  (
    await w.world.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.live_corrections where requested_by_actor_id = $1',
      [w.world.agentActorId],
    )
  )[0]?.n;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('c80agent');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C80 isolation, an agent under a live delegation', () => {
  it('a task pickup’s delegation reaches no correction', async () => {
    const picked = await w.world.pickUp(w.cal, 'task work only');
    const asked = await w.world.asAgent(body(w.partyA, picked.taskId), picked.credential);
    expect(codeOf(asked)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await agentRows()).toBe('0');
  });

  it('a delegation on run:write reaches its own task only', async () => {
    const credential = await mintFor(w.ava, w.taskA);
    const created = await w.as(w.ava, { command: 'task.create', fields: { title: 'other' } });
    const otherTask = 'recordId' in created ? String(created.recordId) : '';
    const asked = await w.world.asAgent(body(w.partyA, otherTask), credential);
    expect(codeOf(asked)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await agentRows()).toBe('0');
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 isolation, an agent under a live delegation, parties',
  () => {
    it('reaches only the parties the delegating person’s grant covers', async () => {
      // Minted while the person holds run:write business-wide (the mint asks
      // for that), then narrowed to party B: the delegation stays live and the
      // person's live grant, read now, covers party B only.
      const fay = await w.world.decider('fay');
      const writeGrant = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await grantTo(tx, fay, 'read', { kind: 'business', id: null }, false, 'run');
        return await grantTo(tx, fay, 'write', { kind: 'business', id: null }, false, 'run');
      });
      const credential = await mintFor(fay, w.taskA);
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await revokeGrant(tx, writeGrant);
        await grantTo(tx, fay, 'write', { kind: 'party', id: w.partyB }, false, 'run');
      });
      const onA = await w.world.asAgent(body(w.partyA, w.taskA), credential);
      expect(codeOf(onA)).toBe('SCOPE_NOT_GRANTED');
      expect(await agentRows()).toBe('0');
      const onB = await w.world.asAgent(body(w.partyB, w.taskA), credential);
      expect(codeOf(onB)).toBe('not-a-refusal');
      expect(await agentRows()).toBe('1');
    });

    it('records the delegating person as the requester, who then cannot approve it', async () => {
      await w.setApprover(w.ava.personId);
      const credential = await mintFor(w.ava, w.taskA);
      const asked = detailOf(await w.world.asAgent(body(w.partyA, w.taskA), credential));
      const id = String(asked['correctionId']);
      const approve = await w.approve(w.ava, id, String(asked['versionId']));
      expect(codeOf(approve)).toBe('SELF_APPROVAL_REFUSED');
      expect(await w.stateOf(id)).toBe('requested');
      await w.setApprover(w.ben.personId);
      expect(codeOf(await w.approve(w.ben, id, String(asked['versionId'])))).toBe('not-a-refusal');
    });
  },
);
