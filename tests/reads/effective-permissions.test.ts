// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.read` (C32, part C32a; CS-2.15, RC-22). `C32 one people list`: every
// name on Team, Clients and Agents is a `people` row, so one rename shows on
// all three; and each preview is the grants' effect, every permission shown
// granted by the grant check (for an agent, the delegation check) and every
// one left out refused. Separation, business to business, client to client
// and person to person, is proved by the cases below.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPeople } from '../../packages/core-commands/src/reads/people.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { checkAuthority, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  mintDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import { enrol, grantTo } from '../commands/fixture.ts';

import {
  serverUrl,
  WHOLE,
  CLIENT_A,
  CLIENT_B,
  TASK_ONE,
  ACTIONS,
  HOUR,
  subjectsOf,
  ids,
  shows,
  db,
  alpha,
  ada,
  ben,
  carla,
  dev,
  agent,
  betaPerson,
  betaAgent,
  seed,
  access,
  everyone,
  previewOf,
} from './effective-permissions-world.ts';

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await seed();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await db.drop();
});

describe.skipIf(serverUrl === undefined)('C32 one people list', () => {
  it('lists Team as exactly the people the assignee list offers', async () => {
    const assignable = await db.app.withBusiness(alpha, async (tx) => await listPeople(tx));
    expect(ids((await access()).team)).toStrictEqual(ids(assignable));
  });

  it('lists as Clients the people with no membership who stand on a live grant', async () => {
    expect(ids((await access()).clients)).toStrictEqual([carla, dev].toSorted());
  });

  it('lists an agent under the person record it draws on', async () => {
    const answer = await access();
    expect(answer.agents.map((entry) => entry.agentActorId)).toStrictEqual([agent.agentActorId]);
    expect(answer.agents[0]?.person.personId).toBe(ada.personId);
  });

  it('renames a person on all three lists with one people row', async () => {
    await db.app.withBusiness(alpha, async (tx) => {
      await tx.query('update people set display_name = $2 where id = $1', [ada.personId, 'Ada L']);
      await tx.query('update people set display_name = $2 where id = $1', [carla, 'Carla M']);
    });
    const answer = await access();
    expect(answer.team.find((person) => person.personId === ada.personId)?.name).toBe('Ada L');
    expect(answer.clients.find((person) => person.personId === carla)?.name).toBe('Carla M');
    expect(answer.agents[0]?.person.name).toBe('Ada L');
  });

  it('previews for each person exactly what the grant check grants them', async () => {
    const answer = await access();
    const asked = ['task', 'access'].flatMap((collection) =>
      ACTIONS.flatMap((action) =>
        [WHOLE, CLIENT_A, CLIENT_B].map((scope) => ({ collection, action, scope })),
      ),
    );
    await db.app.withBusiness(alpha, async (tx) => {
      for (const person of everyone(answer)) {
        // oxlint-disable-next-line no-await-in-loop
        const subjects = await subjectsOf(tx, person.personId);
        // oxlint-disable-next-line no-await-in-loop
        const granted = await Promise.all(
          asked.map(async (request) => (await checkAuthority(tx, subjects, request)).ok),
        );
        const previewed = asked.map((request) => shows(person.permissions, request));
        expect(previewed, person.name).toStrictEqual(granted);
      }
    });
  });
});

describe.skipIf(serverUrl === undefined)('C32 one people list', () => {
  it("shows a client-scoped grant on that client only, and on nobody else's preview", async () => {
    const answer = await access();
    const onA = [{ collection: 'task', action: 'read', scope: CLIENT_A }];
    expect(previewOf(answer, ben.personId)).toStrictEqual(onA);
    expect(previewOf(answer, carla)).toStrictEqual(onA);
    expect(previewOf(answer, dev)).toStrictEqual([
      { collection: 'task', action: 'read', scope: CLIENT_B },
    ]);
  });

  it("previews an agent as its delegation's narrowing of its person, on its one task", async () => {
    const shown = (await access()).agents[0]?.permissions ?? [];
    const granted = await db.app.withBusiness(
      alpha,
      async (tx) =>
        await Promise.all(
          ACTIONS.map(
            async (action) =>
              (
                await checkDelegatedAuthority(tx, agent, {
                  collection: 'task',
                  action,
                  scope: TASK_ONE,
                })
              ).ok,
          ),
        ),
    );
    expect(
      ACTIONS.map((action) => shows(shown, { collection: 'task', action, scope: TASK_ONE })),
    ).toStrictEqual(granted);
    expect(shown.every((permission) => permission.scope.id === TASK_ONE.id)).toBe(true);
  });

  it("never lists another business's people, grants or agents", async () => {
    const answer = await access();
    expect(everyone(answer).map((person) => person.personId)).not.toContain(betaPerson);
    expect(answer.agents.map((entry) => entry.agentActorId)).not.toContain(betaAgent.agentActorId);
    expect(answer.team.filter((person) => person.name === 'Olive')).toHaveLength(1);
  });
});

describe.skipIf(serverUrl === undefined)('C32 one people list', () => {
  it('refuses a teammate without access:manage, and says so rather than answering empty', async () => {
    const denied = await executeRead(db.app, alpha, ada.presented, { read: 'access.read' });
    expect(denied).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect('team' in denied).toBe(false);
    // The refusal names nobody: no client, no other business, no agent.
    for (const id of [carla, dev, betaPerson, agent.agentActorId, CLIENT_A.id ?? '']) {
      expect(JSON.stringify(denied)).not.toContain(id);
    }
  });

  it('drops a revoked grant from the preview on the next read, and from the agent with it', async () => {
    expect(previewOf(await access(), ada.personId)).toHaveLength(2);
    await db.app.withBusiness(alpha, async (tx) => {
      const [write] = await tx.query<{ readonly id: string }>(
        `select id from grants where subject_id = $1 and action = 'write'`,
        [ada.personId],
      );
      await revokeGrant(tx, write?.id ?? '');
    });
    const after = await access();
    expect(previewOf(after, ada.personId)).toStrictEqual([
      { collection: 'task', action: 'read', scope: WHOLE },
    ]);
    expect(after.agents[0]?.permissions.map((permission) => permission.action)).toStrictEqual([
      'read',
    ]);
  });

  it('Sol proof, criterion 8: a former member with no standing has no effective permission preview', async () => {
    const former = await enrol(db.app, alpha, 'Former');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, former, 'read', WHOLE);
      await tx.query(
        'update memberships set active = false, ended_at = now() where person_id = $1',
        [former.personId],
      );
    });

    const refused = await executeRead(db.app, alpha, former.presented, { read: 'task.queue' });
    expect(refused).toMatchObject({ refused: true, code: 'AUTH_NO_MEMBERSHIP' });
    expect(previewOf(await access(), former.personId) ?? []).toStrictEqual([]);
  });
});

describe.skipIf(serverUrl === undefined)('C32 one people list', () => {
  it('shows no permission for a member sign-in refuses ACTOR_INACTIVE', async () => {
    const idle = await enrol(db.app, alpha, 'Idle');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, idle, 'read', WHOLE);
      await tx.query('update actors set active = false, deactivated_at = now() where id = $1', [
        idle.actorId,
      ]);
    });
    const refused = await executeRead(db.app, alpha, idle.presented, { read: 'task.queue' });
    expect(refused).toMatchObject({ refused: true, code: 'ACTOR_INACTIVE' });
    const answer = await access();
    expect(answer.team.map((person) => person.personId)).toContain(idle.personId);
    expect(previewOf(answer, idle.personId)).toStrictEqual([]);
  });

  it("never carries an agent's delegation credential or its digest", async () => {
    const credential = await db.app.withBusiness(alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: await insertAgentActor(tx),
        delegatePersonId: ada.personId,
        mintedByActorId: ada.actorId,
        purpose: 'canary_check',
        collections: ['task'],
        actions: ['read'],
        purposeScope: { kind: 'record', id: TASK_ONE.id ?? '' },
        expiresAt: new Date(Date.now() + HOUR),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    const hashes = await db.app.withBusiness(
      alpha,
      async (tx) =>
        await tx.query<{ readonly credential_hash: string }>(
          'select credential_hash from delegations',
        ),
    );
    const body = JSON.stringify(await access());
    expect(body).toContain('canary_check');
    for (const secret of [credential, ...hashes.map((row) => row.credential_hash)]) {
      expect(body).not.toContain(secret);
    }
  });
});
