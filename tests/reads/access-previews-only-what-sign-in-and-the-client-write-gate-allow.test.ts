// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access previews only what the person could do on a sign-in now.
// A person whose login is no longer linked is refused at sign-in, so they are
// shown nothing, though their actor and grants are live. A client, who has no
// membership, writes only what the envelope's no-membership gate (R4) lets
// through, so a write grant they hold is not previewed as usable. Neither
// rule lets one person's, client's or business's permissions reach another's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { issueGrant, type Action } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { AccessReadResult } from '../../packages/core-wire/src/index.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { addClient, enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();

let db: FreshDatabase;
let alpha: string;
let beta: string;
let owner: Member;
let linked: Member;
let unlinked: Member;
let carla: Member;
let dev: Member;
let betaClient: Member;

/** A party-scoped task grant on `client`, issued by `by`. */
async function onClient(
  tx: TenantQuery,
  personId: string,
  action: Action,
  client: string,
  by: string,
): Promise<void> {
  const issued = await issueGrant(tx, [], {
    subject: { kind: 'person', id: personId },
    scope: { kind: 'party', id: client },
    collection: 'task',
    action,
    parentGrantId: null,
    grantedByActorId: by,
  });
  if (!issued.ok) throw new Error(`grant refused ${issued.refusal.code}`);
}

/** A client of the business: a signed-in person with no membership. */
async function clientPerson(tx: TenantQuery, name: string, by: string): Promise<Member> {
  const personId = await insertPerson(tx, name);
  const actorId = await insertActor(tx, personId);
  const subject = `${name}-${randomUUID()}`;
  await insertMapping(tx, await insertLogin(tx, subject), personId, by);
  return { personId, actorId, presented: { provider: 'supabase', subject } };
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'access_preview_gate' });
  alpha = await insertBusiness(db.app, 'access-preview-alpha');
  beta = await insertBusiness(db.app, 'access-preview-beta');
  owner = await enrol(db.app, alpha, 'Olive');
  linked = await enrol(db.app, alpha, 'Lena');
  unlinked = await enrol(db.app, alpha, 'Uma');
  await addClient(db.app, alpha, CLIENT_A, owner);
  await addClient(db.app, alpha, CLIENT_B, owner);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, owner, 'manage', undefined, false, 'access');
    await grantTo(tx, linked, 'read');
    await grantTo(tx, unlinked, 'read');
    await tx.query(
      `update person_logins set active = false, deactivated_at = now() where person_id = $1`,
      [unlinked.personId],
    );
    carla = await clientPerson(tx, 'Carla', owner.actorId);
    for (const action of ['read', 'comment', 'write', 'assign'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction and connection
      await onClient(tx, carla.personId, action, CLIENT_A, owner.actorId);
    }
    dev = await clientPerson(tx, 'Dev', owner.actorId);
    await onClient(tx, dev.personId, 'read', CLIENT_B, owner.actorId);
  });
  const betaOwner = await enrol(db.app, beta, 'Olive');
  const betaParty = randomUUID();
  await addClient(db.app, beta, betaParty, betaOwner);
  await db.app.withBusiness(beta, async (tx) => {
    betaClient = await clientPerson(tx, 'Bea', betaOwner.actorId);
    await onClient(tx, betaClient.personId, 'write', betaParty, betaOwner.actorId);
  });
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await db.drop();
});

async function access(): Promise<AccessReadResult> {
  const answer = await executeRead(db.app, alpha, owner.presented, { read: 'access.read' });
  if (!('team' in answer)) throw new Error(`access.read refused ${JSON.stringify(answer)}`);
  return answer;
}

const keysOf = (answer: AccessReadResult, personId: string): string[] =>
  [...answer.team, ...answer.clients]
    .find((person) => person.personId === personId)
    ?.permissions.map(({ collection, action, scope }) => `${collection}:${action}:${scope.id}`)
    .toSorted() ?? [];

describe.skipIf(serverUrl === undefined)('Settings ▸ Access preview', () => {
  it('shows no permission for a member whose login was unlinked, as sign-in refuses them', async () => {
    const refused = await executeRead(db.app, alpha, unlinked.presented, { read: 'task.queue' });
    expect(refused).toMatchObject({ refused: true });
    const answer = await access();
    expect(answer.team.map((person) => person.personId)).toContain(unlinked.personId);
    expect(keysOf(answer, unlinked.personId)).toStrictEqual([]);
    expect(keysOf(answer, linked.personId)).toStrictEqual(['task:read:null']);
  });

  it("previews a client's read and comment but not the write and assign the no-membership gate refuses", async () => {
    const answer = await access();
    expect(answer.clients.map((person) => person.personId)).toContain(carla.personId);
    expect(keysOf(answer, carla.personId)).toStrictEqual([
      `task:comment:${CLIENT_A}`,
      `task:read:${CLIENT_A}`,
    ]);
    // Each client keeps their own: Dev reads client B only, and nothing of Carla's.
    expect(keysOf(answer, dev.personId)).toStrictEqual([`task:read:${CLIENT_B}`]);
    // Carla's grant rows are all still listed, so each can be revoked.
    const listed = answer.clients.find((person) => person.personId === carla.personId);
    expect(listed?.grants.map((grant) => grant.action).toSorted()).toStrictEqual([
      'assign',
      'comment',
      'read',
      'write',
    ]);
  });

  it("never shows another business's client or grant", async () => {
    const body = JSON.stringify(await access());
    expect(body).not.toContain(betaClient.personId);
    expect(body).not.toContain('Bea');
  });
});
