// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.read` (C32, part C32a; CS-2.15, RC-22). `C32 one people list`: every
// name on Team, Clients and Agents is a `people` row, so one rename shows on
// all three; and each preview is the grants' effect, every permission shown
// granted by the grant check (for an agent, the delegation check) and every
// one left out refused. Separation, business to business, client to client
// and person to person, is proved by the cases below.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPeople } from '../../packages/core-commands/src/reads/people.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  checkAuthority,
  issueGrant,
  revokeGrant,
  type Action,
  type Scope,
  type Subject,
} from '../../packages/core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  mintDelegation,
  type Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertPerson,
} from '../identity/fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import type { AccessPermission, AccessReadResult } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

const WHOLE: Scope = { kind: 'business', id: null };
const CLIENT_A: Scope = { kind: 'party', id: randomUUID() };
const CLIENT_B: Scope = { kind: 'party', id: randomUUID() };
const TASK_ONE: Scope = { kind: 'record', id: randomUUID() };
const ACTIONS: readonly Action[] = [
  'read',
  'comment',
  'write',
  'assign',
  'decide',
  'share',
  'manage',
];
const HOUR = 3_600_000;

/** A root grant, as an administrative path issues it. */
async function root(
  tx: TenantQuery,
  subject: Subject,
  action: Action,
  scope: Scope,
  by: string,
): Promise<string> {
  const issued = await issueGrant(tx, [], {
    subject,
    scope,
    collection: 'task',
    action,
    parentGrantId: null,
    grantedByActorId: by,
  });
  if (!issued.ok) throw new Error(`root grant refused ${issued.refusal.code}`);
  return issued.value;
}

/** A client person: no membership, standing only on the grant given here. */
async function client(tx: TenantQuery, name: string, scope: Scope, by: string): Promise<string> {
  const personId = await insertPerson(tx, name);
  await insertActor(tx, personId);
  await root(tx, { kind: 'person', id: personId }, 'read', scope, by);
  return personId;
}

async function agentFor(tx: TenantQuery, person: Member, actions: Action[]): Promise<Delegation> {
  const minted = await mintDelegation(tx, {
    agentActorId: await insertAgentActor(tx),
    delegatePersonId: person.personId,
    mintedByActorId: person.actorId,
    purpose: 'task_work',
    collections: ['task'],
    actions,
    purposeScope: { kind: 'record', id: TASK_ONE.id ?? '' },
    expiresAt: new Date(Date.now() + HOUR),
  });
  if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
  return minted.value.delegation;
}

async function subjectsOf(tx: TenantQuery, personId: string): Promise<Subject[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from actors where person_id = $1 and kind = 'person' and active`,
    [personId],
  );
  return [
    { kind: 'person', id: personId },
    { kind: 'actor', id: rows[0]?.id ?? randomUUID() },
  ];
}

const ids = (list: readonly { readonly personId: string }[]): string[] =>
  list.map((entry) => entry.personId).toSorted();

/** Whether a shown permission covers a request: the same pair, at business scope or the same one. */
function shows(permissions: readonly AccessPermission[], asked: AccessPermission): boolean {
  return permissions.some(
    (held) =>
      held.collection === asked.collection &&
      held.action === asked.action &&
      (held.scope.kind === 'business' ||
        (held.scope.kind === asked.scope.kind && held.scope.id === asked.scope.id)),
  );
}

let db: FreshDatabase;
let alpha: BusinessId;
let owner: Member;
let ada: Member;
let ben: Member;
let carla: string;
let dev: string;
let agent: Delegation;
let betaPerson: string;
let betaAgent: Delegation;

async function seed(): Promise<void> {
  db = await createFreshDatabase({ part: 'c32a' });
  alpha = (await insertBusiness(db.app, 'c32a-alpha')) as BusinessId;
  const beta = (await insertBusiness(db.app, 'c32a-beta')) as BusinessId;
  owner = await enrol(db.app, alpha, 'Olive');
  ada = await enrol(db.app, alpha, 'Ada');
  ben = await enrol(db.app, alpha, 'Ben');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, owner, 'manage', WHOLE, false, 'access');
    await grantTo(tx, ada, 'read', WHOLE);
    await grantTo(tx, ada, 'write', WHOLE);
    // Ben reaches one client only, through his acting identity.
    await root(tx, { kind: 'actor', id: ben.actorId }, 'read', CLIENT_A, owner.actorId);
    carla = await client(tx, 'Carla', CLIENT_A, owner.actorId);
    dev = await client(tx, 'Dev', CLIENT_B, owner.actorId);
    // A client whose only grant was revoked stands on nothing.
    const gone = await insertPerson(tx, 'Gone');
    await revokeGrant(
      tx,
      await root(tx, { kind: 'person', id: gone }, 'read', CLIENT_B, owner.actorId),
    );
    agent = await agentFor(tx, ada, ['read', 'write']);
  });
  const betaOwner = await enrol(db.app, beta, 'Olive');
  betaPerson = betaOwner.personId;
  await db.app.withBusiness(beta, async (tx) => {
    await grantTo(tx, betaOwner, 'manage', WHOLE, false, 'access');
    await grantTo(tx, betaOwner, 'read', WHOLE);
    betaAgent = await agentFor(tx, betaOwner, ['read']);
  });
}

async function access(): Promise<AccessReadResult> {
  const answer = await executeRead(db.app, alpha, owner.presented, { read: 'access.read' });
  if (!('team' in answer)) throw new Error(`access.read refused ${JSON.stringify(answer)}`);
  return answer;
}

const everyone = (answer: AccessReadResult) => [...answer.team, ...answer.clients];
const previewOf = (answer: AccessReadResult, personId: string) =>
  everyone(answer).find((person) => person.personId === personId)?.permissions;

describe.skipIf(serverUrl === undefined)('C32 one people list', () => {
  beforeAll(seed, 180_000);
  afterAll(async () => {
    if (serverUrl !== undefined) await db.drop();
  });

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

  it('refuses a teammate without access:manage, and says so rather than answering empty', async () => {
    const denied = await executeRead(db.app, alpha, ada.presented, { read: 'access.read' });
    expect(denied).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect('team' in denied).toBe(false);
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
