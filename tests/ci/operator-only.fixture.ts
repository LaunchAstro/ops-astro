// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-1e operator-only suites' shared fixtures (operator-only*.test.ts): the
// commands as the owner runs them, a PATH whose docker and launchctl log every
// call, the key set on loopback, and the database with its people and callers.
// `operatorOnlyHooks()` makes and drops that database in the calling describe.

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  serveTestKeySetApart,
  signBearer,
  signForged,
  TEST_ISSUER,
  type ServedKeySet,
} from '../support/sign-in.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { CANARY, scratch, type Marks } from './operator-only-commands.fixture.ts';

export const ISSUER: string = TEST_ISSUER;

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

/** The test key set on loopback, in its own process: the gate runs under spawnSync. */
export let keySet: ServedKeySet | undefined;
export let keySetUrl = '';
afterAll(async () => await keySet?.close());

/** A sign-in's ES256 bearer, as the provider issues it; `forged` signs with a stranger's key. */
export const token = async (subject: string, forged = false): Promise<string> =>
  await (forged ? signForged : signBearer)({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 600,
  });

// ---- the gate's own refusals, before any database is asked ----------------

/** A person with a login and a membership; the grant, if any, is on `operations`. */
export const person = async (
  tx: TenantQuery,
  name: string,
  subject: string,
  grant?: { scope: 'business' | 'party'; action?: 'manage' | 'read' },
): Promise<string> => {
  const id = await insertPerson(tx, name);
  const actor = await insertActor(tx, id);
  await insertMembership(tx, id);
  await insertMapping(tx, await insertLogin(tx, subject), id, actor);
  if (grant !== undefined) {
    const issued = await issueGrant(tx, [{ kind: 'actor', id: actor }], {
      subject: { kind: 'person', id },
      scope:
        grant.scope === 'business'
          ? { kind: 'business', id: null }
          : { kind: 'party', id: randomUUID() },
      collection: 'operations',
      action: grant.action ?? 'manage',
      parentGrantId: null,
      grantedByActorId: actor,
    });
    expect(issued.ok).toBe(true);
  }
  return id;
};

// ---- the table, over a real database ---------------------------------------

let db: FreshDatabase;

let alphaBusiness = '';

export const subjects = {
  operator: `op-${randomUUID()}`,
  keyless: `kl-${randomUUID()}`,
  client: `cl-${randomUUID()}`,
  agent: `ag-${randomUUID()}`,
  betaOperator: `bo-${randomUUID()}`,
};

let operatorPerson = '';

export const adminUrl = (): string => {
  const url = new URL(serverUrl as string);
  url.pathname = `/${db.name}`;
  return url.toString();
};

export const environment = (
  at: Marks,
  path: string,
  own: Record<string, string>,
): {
  [name: string]: string;
  PATH: string;
  OPS_ASTRO_DEPLOYMENTS: string;
} => ({
  PATH: path,
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_DEPLOYMENTS: at.records,
  DATABASE_URL: db.appUrl,
  DATABASE_ADMIN_URL: adminUrl(),
  SUPABASE_KEY_SET_URL: keySetUrl,
  GOTRUE_URL: ISSUER,
  ...own,
});

export const CALLERS: Record<string, () => Promise<Record<string, string>>> = {
  'an agent credential': async () => ({ OPS_ASTRO_TOKEN: await token(subjects.agent) }),
  'an agent credential, flagged as one': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.agent),
    OPS_ASTRO_AGENT: '1',
  }),
  "the operator's own sign-in under a delegation": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator),
    OPS_ASTRO_DELEGATION: CANARY,
  }),
  "the operator's own sign-in with a saved delegation": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  }),
  'a person without the key (operations:read only)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.keyless),
  }),
  'a person holding the key for one client only': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.client),
  }),
  "another business's operator": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
  }),
  'a forged sign-in': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator, true),
  }),
};

/** What the calling suite's cases read directly, handed over once the database is made. */
export interface OperatorOnlyState {
  readonly db: FreshDatabase;
  readonly alphaBusiness: string;
  readonly operatorPerson: string;
}

/** The real database, its businesses, people and planted agent grant, for the calling describe. */
export function operatorOnlyHooks(share: (state: OperatorOnlyState) => void): void {
  beforeAll(async () => {
    keySet = await serveTestKeySetApart();
    keySetUrl = keySet.url;
    db = await createFreshDatabase({ part: 's01e' });
    const alpha = await insertBusiness(db.app, 'alpha');
    alphaBusiness = alpha;
    const beta = await insertBusiness(db.app, 'beta');
    // Installation: alpha is the operating business, written once by the owner
    // (migration 0045); the restore drill's modes are its operator's alone.
    await db.admin.execute('insert into ops.operating_business (operating_business) values ($1)', [
      alpha,
    ]);
    await db.app.withBusiness(alpha, async (tx) => {
      operatorPerson = await person(tx, 'Olive', subjects.operator, { scope: 'business' });
      await person(tx, 'Kit', subjects.keyless, { scope: 'business', action: 'read' });
      await person(tx, 'Cleo', subjects.client, { scope: 'party' });
      // An agent login, and a grant row planted on the agent's own actor: an
      // agent credential is refused even where a row names it.
      const agent = await insertAgentActor(tx);
      await insertAgentMapping(tx, await insertLogin(tx, subjects.agent), agent, agent);
      const planted = await issueGrant(tx, [{ kind: 'actor', id: agent }], {
        subject: { kind: 'actor', id: agent },
        scope: { kind: 'business', id: null },
        collection: 'operations',
        action: 'manage',
        parentGrantId: null,
        grantedByActorId: agent,
      });
      expect(planted.ok).toBe(true);
    });
    await db.app.withBusiness(beta, async (tx) => {
      await person(tx, 'Bea', subjects.betaOperator, { scope: 'business' });
    });
    share({ db, alphaBusiness, operatorPerson });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
    rmSync(scratch, { recursive: true, force: true });
  });
}
