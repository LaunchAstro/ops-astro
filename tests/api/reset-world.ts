// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the reset cases open against a real login provider: the pinned
// GoTrue at `RESET_AUTH_URL`, signing with the keys at `RESET_AUTH_KEYS`, and
// the API composed as the server composes it, its sign-ins checked against
// that provider's own published keys. Two businesses, alpha and bravo, over a
// throwaway database. Without the provider the cases skip;
// `reset-provider-containers.mjs` starts both and runs them.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { afterAll, beforeAll } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
// @ts-expect-error -- existing local JavaScript tool has no declarations
import { serviceToken } from '../../scripts/local/signing-key.mjs';
import { authorised, post, type Answer } from './fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

export const issuer: string | undefined = process.env['RESET_AUTH_URL'];
const keysPath = process.env['RESET_AUTH_KEYS'] ?? '';

/** Whether the database and the provider are both there; a case skips otherwise. */
export const providerReady: boolean =
  issuer !== undefined && keysPath !== '' && databaseUrlFromEnvironment() !== undefined;

export let db: FreshDatabase;
export let api: Hono;
export let alpha: BusinessId;
export let bravo: BusinessId;

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The provider's answer, its status and JSON body. */
async function provider(
  method: string,
  path: string,
  body?: object,
  token?: string,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${issuer ?? ''}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const admin = async (path: string, body: object) =>
  await provider(
    'POST',
    path,
    body,
    (await serviceToken(JSON.parse(readFileSync(keysPath, 'utf8')))) as string,
  );

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`the provider's answer has no ${key}`);
  return value;
}

/** A person with a provider login, mapped and a member in each business named. */
export interface Person {
  readonly email: string;
  readonly password: string;
  readonly subject: string;
  /** The person's id in each business they are in. */
  readonly people: ReadonlyMap<BusinessId, string>;
}

export async function personIn(...businesses: readonly BusinessId[]): Promise<Person> {
  const email = `reset-${randomUUID()}@example.test`;
  const password = `first-${randomBytes(9).toString('base64url')}`;
  const created = await admin('/admin/users', { email, password, email_confirm: true });
  const subject = field(created.body, 'id');
  const people = new Map<BusinessId, string>();
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business after another
    await db.app.withBusiness(business, async (tx) => {
      const person = await insertPerson(tx, 'Reset');
      const actor = await insertActor(tx, person);
      await insertMembership(tx, person);
      await insertMapping(tx, await insertLogin(tx, subject), person, actor);
      people.set(business, person);
    });
  }
  return { email, password, subject, people };
}

/** The login's authenticator, verified in `business`, as C59 records one. */
export async function factorVerified(person: Person, business: BusinessId): Promise<void> {
  const personId = person.people.get(business) ?? '';
  await db.app.withBusiness(business, async (tx) => {
    const factor = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: randomUUID(),
    });
    await recordFactorVerified(tx, { personId, factorId: factor.id, subject: person.subject });
  });
}

/** A recovery link the service minted and mailed for the login, recorded as it records one. */
export async function linkMinted(person: Person, secondsAgo = 5): Promise<void> {
  await db.admin.execute(
    `insert into ops.recovery_links (id, subject_digest, minted_at)
     values (gen_random_uuid(), $1, clock_timestamp() - make_interval(secs => $2))`,
    [digest(person.subject), secondsAgo],
  );
}

/** A session the provider opens on a mailed link: recovery, or a sign-in link. */
export async function linkSession(
  person: Person,
  type: 'recovery' | 'magiclink' = 'recovery',
): Promise<string> {
  const link = await admin('/admin/generate_link', { type, email: person.email });
  const verified = await provider('POST', '/verify', {
    type,
    token_hash: field(link.body, 'hashed_token'),
  });
  return field(verified.body, 'access_token');
}

/** An ordinary sign-in with the person's password. */
export async function signIn(person: Person, password: string = person.password): Promise<string> {
  const answer = await provider('POST', '/token?grant_type=password', {
    email: person.email,
    password,
  });
  return field(answer.body, 'access_token');
}

/** The page's password write, straight to the provider on the recovery session. */
export const writePassword = async (
  token: string,
  password: string,
): Promise<{ readonly status: number }> => await provider('PUT', '/user', { password }, token);

export const begin = async (token: string): Promise<Answer> =>
  await post(api, '/api/password/begin', {}, authorised(token));

export const changed = async (token: string): Promise<Answer> =>
  await post(api, '/api/password/changed', {}, authorised(token));

/** What the door answers a bearer in a business: `served`, or its sign-in refusal's code. */
export async function door(token: string, key: 'alpha' | 'bravo'): Promise<string> {
  const answer = await post(api, `/api/b/${key}/session/capabilities`, {}, authorised(token));
  return answer.status === 401 ? String(answer.body['code']) : 'served';
}

/** The windows a session opened, and whether each settled. */
export async function windowsOf(
  token: string,
): Promise<readonly { readonly settled: boolean; readonly reset_settled: boolean }[]> {
  const rows = await db.admin.execute<{
    readonly settled: boolean;
    readonly reset_settled: boolean;
  }>(
    `select r.settled_at is not null as settled, s.settled_at is not null as reset_settled
       from ops.recovery_resets r join ops.subject_resets s on s.id = r.reset_id
      where r.session_digest = $1`,
    [digest(sessionOf(token))],
  );
  return rows.map(({ settled, reset_settled }) => ({ settled, reset_settled }));
}

/** The reset's audit rows for the person in a business, each as its whole row. */
export async function auditsOf(person: Person, business: BusinessId): Promise<readonly string[]> {
  const rows = await db.admin.execute<{ readonly row: string }>(
    `select to_jsonb(a)::text as row from public.audit_events a
      where a.business_id = $1 and a.command = 'account.password_reset'
        and a.actor_id in (
          select id from public.actors where business_id = $1 and person_id = $2)
      order by a.seq`,
    [business, person.people.get(business) ?? ''],
  );
  return rows.map(({ row }) => row);
}

/** The `session_id` a provider token carries. */
export function sessionOf(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return String((claims as Record<string, unknown>)['session_id']);
}

export const now = (): number => Math.floor(Date.now() / 1000);

/** The hooks a reset file calls at module level. */
export function useResetWorld(part: string): void {
  beforeAll(async () => {
    if (!providerReady || issuer === undefined) return;
    db = await createFreshDatabase({ part });
    alpha = (await insertBusiness(db.app, 'alpha')) as BusinessId;
    bravo = (await insertBusiness(db.app, 'bravo')) as BusinessId;
    api = composeApi({
      keys: runtimeKeys({
        GATE_SIGNING_KEY_ID: `test/reset@${part}`,
        GATE_SIGNING_SECRET: randomUUID(),
      }),
      database: db.app,
      admin: db.admin,
      signIn: { issuer, keySetUrl: `${issuer}/.well-known/jwks.json` },
      executeRead,
    }).app;
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });
}
