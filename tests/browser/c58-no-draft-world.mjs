// SPDX-License-Identifier: AGPL-3.0-only
//
// What `cases-c58-no-draft.mjs` needs from outside the page: ND1's own
// person, whose access it ends, and ND2's token past the 12-hour limit.
//
// ND1 never ends a seeded login. Every seeded one is used by a later group,
// and an ended access cannot be put back. So it makes a login in the identity
// provider, a person, a membership and business-wide task grants of its own,
// the way `db:seed` makes the cast's, and each run leaves that one ended
// person behind.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../packages/core-records/src/index.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { WEB, root } from './harness.mjs';
import { identityOf } from './i10-open-page.mjs';

/** What ND1's person may do: enough to open a task, edit it and comment. */
const MEMBER_GRANTS = [
  ['task', 'read'],
  ['task', 'write'],
  ['task', 'comment'],
  ['person', 'read'],
];

const authEnv = (name) =>
  process.env[name] || readEnvFile(`${root}.local/auth.env`, { required: true })[name];

const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** HS256 over `header.payload` with the provider's key, as the API verifies it. */
function signed(unsigned) {
  const signature = createHmac('sha256', authEnv('SUPABASE_JWT_SECRET'))
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

/**
 * The page's own token with its first sign-in moved to 12 hours and one second
 * ago, signed again with the provider's key. Nothing else changes, so the only
 * reason the API has to refuse it is the absolute limit.
 */
export function pastTheLimit(token) {
  const [header, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const then = Math.floor(Date.now() / 1000) - SESSION_ABSOLUTE_SECONDS - 1;
  for (const entry of claims.amr ?? []) entry.timestamp = then;
  return signed(`${header}.${segment(claims)}`);
}

/** A login in the provider, made through its admin API as `auth:seed` does. */
async function providerLogin(email, password) {
  const now = Math.floor(Date.now() / 1000);
  const service = signed(
    `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({
      role: 'service_role',
      aud: 'authenticated',
      iss: 'ops-astro-browser-nd1',
      iat: now,
      exp: now + 300,
    })}`,
  );
  const created = await fetch(`${authEnv('GOTRUE_URL')}/admin/users`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${service}`,
      apikey: service,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const subject = (await created.json()).id;
  if (!created.ok || typeof subject !== 'string') {
    throw new Error(`ND1: the provider did not create a login (${String(created.status)})`);
  }
  return subject;
}

/** The person, acting identity, login mapping, membership and grants. */
async function seedMember(tx, { subject, name, grantedBy }) {
  const [person, actor, login] = [randomUUID(), randomUUID(), randomUUID()];
  await tx.query('insert into public.people (business_id, id, display_name) values ($1,$2,$3)', [
    tx.businessId,
    person,
    name,
  ]);
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id, active)
     values ($1,$2,'person',$3,true)`,
    [tx.businessId, actor, person],
  );
  await tx.query(
    `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
    [tx.businessId, login, subject],
  );
  await tx.query(
    `insert into public.person_logins
       (business_id, id, login_id, person_id, active, linked_by_actor_id)
     values ($1,$2,$3,$4,true,$5)`,
    [tx.businessId, randomUUID(), login, person, actor],
  );
  await tx.query(
    `insert into public.memberships (business_id, id, person_id, role_key, active)
     values ($1,$2,$3,'member',true)`,
    [tx.businessId, randomUUID(), person],
  );
  for (const [collection, action] of MEMBER_GRANTS) {
    // One grant at a time: they share the transaction's connection.
    // oxlint-disable-next-line no-await-in-loop
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: person },
      scope: { kind: 'business', id: null },
      collection,
      action,
      parentGrantId: null,
      grantedByActorId: grantedBy,
    });
    if (!issued.ok) throw new Error(`ND1: issueGrant refused ${issued.refusal.code}`);
  }
  return person;
}

/** ND1's person, signed in nowhere yet: `{ email, password, personId }`. */
export async function throwawayMember({ database, admin, alpha, stamp }) {
  const email = `nd1-${stamp.replaceAll(/[^0-9]/gu, '')}@alpha.local`;
  const password = randomBytes(18).toString('base64url');
  const subject = await providerLogin(email, password);
  const ada = await identityOf(admin, alpha, 'ada@alpha.local');
  const personId = await database.withBusiness(alpha, (tx) =>
    seedMember(tx, { subject, name: `ND1 ${stamp}`, grantedBy: ada.actorId }),
  );
  return { email, password, personId };
}

/** Sign in through the real form with a password `harness.mjs` does not hold. */
export async function signInAs(page, email, password) {
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#signin-email');
  await page.fill('#signin-email', email);
  await page.fill('#signin-password', password);
  await page.selectOption('#signin-business', 'alpha');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });
}
