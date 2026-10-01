// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `effective-permissions.test.ts` reads (C32, part C32a): alpha with
// its owner, two teammates, two clients and an agent, and beta with a person
// and an agent of its own, seeded once, and the helpers the cases share.

import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  issueGrant,
  revokeGrant,
  type Action,
  type Scope,
  type Subject,
} from '../../packages/core-records/src/authority/grants.ts';
import {
  mintDelegation,
  type Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertPerson,
} from '../identity/fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import type { AccessPermission, AccessReadResult } from '../../packages/core-wire/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const WHOLE: Scope = { kind: 'business', id: null };
export const CLIENT_A: Scope = { kind: 'party', id: randomUUID() };
export const CLIENT_B: Scope = { kind: 'party', id: randomUUID() };
export const TASK_ONE: Scope = { kind: 'record', id: randomUUID() };
export const ACTIONS: readonly Action[] = [
  'read',
  'comment',
  'write',
  'assign',
  'decide',
  'share',
  'manage',
];
export const HOUR = 3_600_000;

/** A root grant, as an administrative path issues it. */
export async function root(
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
export async function client(
  tx: TenantQuery,
  name: string,
  scope: Scope,
  by: string,
): Promise<string> {
  const personId = await insertPerson(tx, name);
  await insertActor(tx, personId);
  await root(tx, { kind: 'person', id: personId }, 'read', scope, by);
  return personId;
}

export async function agentFor(
  tx: TenantQuery,
  person: Member,
  actions: Action[],
): Promise<Delegation> {
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

export async function subjectsOf(tx: TenantQuery, personId: string): Promise<Subject[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from actors where person_id = $1 and kind = 'person' and active`,
    [personId],
  );
  return [
    { kind: 'person', id: personId },
    { kind: 'actor', id: rows[0]?.id ?? randomUUID() },
  ];
}

export const ids = (list: readonly { readonly personId: string }[]): string[] =>
  list.map((entry) => entry.personId).toSorted();

/** Whether a shown permission covers a request: the same pair, at business scope or the same one. */
export function shows(permissions: readonly AccessPermission[], asked: AccessPermission): boolean {
  return permissions.some(
    (held) =>
      held.collection === asked.collection &&
      held.action === asked.action &&
      (held.scope.kind === 'business' ||
        (held.scope.kind === asked.scope.kind && held.scope.id === asked.scope.id)),
  );
}

export let db: FreshDatabase;
export let alpha: BusinessId;
export let owner: Member;
export let ada: Member;
export let ben: Member;
export let carla: string;
export let dev: string;
export let agent: Delegation;
export let betaPerson: string;
export let betaAgent: Delegation;

export async function seed(): Promise<void> {
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

export async function access(): Promise<AccessReadResult> {
  const answer = await executeRead(db.app, alpha, owner.presented, { read: 'access.read' });
  if (!('team' in answer)) throw new Error(`access.read refused ${JSON.stringify(answer)}`);
  return answer;
}

type Listed = AccessReadResult['team'][number] | AccessReadResult['clients'][number];

export const everyone = (answer: AccessReadResult): Listed[] => [...answer.team, ...answer.clients];
export const previewOf = (
  answer: AccessReadResult,
  personId: string,
): Listed['permissions'] | undefined =>
  everyone(answer).find((person) => person.personId === personId)?.permissions;
