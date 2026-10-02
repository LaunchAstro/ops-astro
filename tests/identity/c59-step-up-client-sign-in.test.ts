// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (Q1, the director's ruling of 2 October 2026): a client, who may have no
// second factor, meets the money step-up with a password sign-in, so the
// refusal says so and names `sign_in` for the page to ask for the password. A
// team member's refusal is unchanged: no names, and the code from the app.
//
// No real command lets a client reach a money key today (`EXTERNAL_WRITES`),
// so the client's money act is the comment row asked about `billing:decide`,
// run through the real preparation, grant check and all, on a share of one
// record. The team member's is the stand-in of `c59-step-up-person.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_UP_WINDOW_SECONDS } from '../../packages/core-records/src/authority/step-up.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { Assurance } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  withSession,
  type VerifiedSubject,
} from '../../packages/core-records/src/identity/login-resolution.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { prepareCommand } from '../../packages/core-commands/src/commands/prepare.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import { declarationOf, type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from './fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let ava: Member;
let client: Member;
const RECORD = randomUUID();

/** The team member's money act: the settings row asked about `billing:decide`. */
const TEAM_MONEY: CommandDeclaration = {
  ...declarationOf('settings.set_client_sign_off'),
  collection: 'billing',
  action: 'decide',
};

/** The client's: the comment row, which a client may send, asked about `billing:decide`. */
const CLIENT_MONEY: CommandDeclaration = {
  ...declarationOf('task.comment'),
  collection: 'billing',
  action: 'decide',
};

const NOW = (): number => Math.floor(Date.now() / 1000);
const stale = (): Assurance => {
  const at = NOW() - STEP_UP_WINDOW_SECONDS - 3600;
  return { level: 'aal1', signedInAt: at, factorAt: null };
};

/** A root grant from ava to `personId`, on the one record. */
const share = async (tx: TenantQuery, personId: string, collection: string, action: 'read') =>
  await issueGrant(tx, [], {
    subject: { kind: 'person', id: personId },
    scope: { kind: 'record', id: RECORD },
    collection,
    action,
    parentGrantId: null,
    grantedByActorId: ava.actorId,
  });

/** The refusal `prepareCommand` gave, whole, or 'prepared'. */
const prepare = async (
  presented: VerifiedSubject,
  body: UncheckedRequest,
  declaration: CommandDeclaration,
) =>
  await withSession(db.app, alpha, presented, async (tx, session) => {
    const prepared = await prepareCommand(tx, session, 'api', body, declaration);
    return 'refusal' in prepared ? prepared.refusal : 'prepared';
  });

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59client' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  await db.app.withBusiness(alpha, async (tx) => await installBusinessSettings(tx));
  ava = await enrol(db.app, alpha, 'ava');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ava, 'decide', WHOLE_BUSINESS, false, 'billing');
    await grantTo(tx, ava, 'read', WHOLE_BUSINESS, false, 'settings');
  });
  client = await db.app.withBusiness(alpha, async (tx) => {
    const subject = `client-${randomUUID()}`;
    const personId = await insertPerson(tx, 'Cleo');
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, ava.actorId);
    // The read share is what gives a client standing; the decide one is the money key.
    for (const [collection, action] of [
      ['task', 'read'],
      ['billing', 'decide'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const issued = await share(tx, personId, collection, action as 'read');
      if (!issued.ok) throw new Error(`share refused ${issued.refusal.code}`);
    }
    return { personId, actorId, presented: { provider: 'supabase', subject } };
  });
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C59 a client meets the step-up with a sign-in', () => {
  it('C59 client step-up: a client’s stale money refusal names sign_in and says sign in again with your password', async () => {
    const refused = await prepare(
      { ...client.presented, assurance: stale() },
      { command: 'task.comment', operationId: randomUUID(), recordId: RECORD, body: 'Yes' },
      CLIENT_MONEY,
    );
    expect(refused).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      names: ['sign_in'],
      fixes: [
        'Sign in again with your password, then retry.',
        'A money action needs a sign-in in the last 60 minutes.',
      ],
    });
  });

  it('C59 team step-up: a team member’s stale money refusal is unchanged, naming nothing and asking for the code', async () => {
    const at = NOW() - STEP_UP_WINDOW_SECONDS - 3600;
    const refused = await prepare(
      { ...ava.presented, assurance: { level: 'aal2', signedInAt: at, factorAt: at } },
      { command: 'settings.set_client_sign_off', operationId: randomUUID(), value: true },
      TEAM_MONEY,
    );
    expect(refused).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      names: [],
      fixes: [
        'Sign in again with the code from your authenticator app, then retry.',
        'A money action needs a sign-in with the second factor in the last 60 minutes.',
      ],
    });
  });
});
