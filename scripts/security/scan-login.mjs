// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's scan login, the command (ticket S0-5 item 7). The
// decisions are in `scan-login.ts`; this file runs them.
//
//   node scripts/security/scan-login.mjs make|remove
//
// Settings: deploy/staging/SECURITY-SCAN.md, plus SCAN_LOGIN_PLACE (staging or
// local), SCAN_LOGIN_FILE and SCAN_TOKEN_FILE (written owner-only). `make` writes
// SCAN_LOGIN_FILE once the sign-in exists, so `remove` finds it even when `make`
// stopped part way. Exit 0 when done, 1 when refused or stopped. Nothing
// printed carries an address, a key, a password or the token.

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { endPersonAuthority } from '../../packages/core-commands/src/commands/authority-controls.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  loginRecord,
  removalRefusal,
  SCAN_BUSINESS,
  SCAN_GRANTS,
  SCAN_PERSON,
  scanEmail,
  scanLoginRefusal,
} from './scan-login.ts';

const env = process.env;
const args = process.argv.slice(2);
class Stopped extends Error {}
const stop = (why) => {
  throw new Stopped(why);
};
const refusal = scanLoginRefusal(env, args);
if (refusal !== undefined) {
  console.error(`scan-login: ${refusal}. Nothing was done.`);
  process.exit(1);
}

const admin = {
  authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  apikey: env.SUPABASE_SERVICE_KEY,
};
async function provider(path, method, body, headers = admin) {
  const response = await fetch(`${env.GOTRUE_URL}${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const keep = (file, text) => writeFileSync(file, text, { mode: 0o600 });

/** The business's id, read as the lookup identity reads it (`apps/api/server.ts`). */
async function businessId() {
  const lookup = connectAsAdmin(env.DATABASE_LOOKUP_URL, { source: 'scan-login' });
  try {
    const rows = await lookup.transaction(async (execute) => {
      await execute('set local role ops_astro_lookup');
      return await execute('select id from public.businesses where key = $1 limit 2', [
        SCAN_BUSINESS,
      ]);
    });
    if (rows.length !== 1) stop(`the business ${SCAN_BUSINESS} was not found once`);
    return rows[0].id;
  } finally {
    await lookup.close();
  }
}

/** The person, acting identity, login mapping, membership and grants, in one transaction. */
async function member(tx, subject) {
  const [personId, actorId, loginId] = [randomUUID(), randomUUID(), randomUUID()];
  const id = tx.businessId;
  await tx.query('insert into public.people (business_id, id, display_name) values ($1,$2,$3)', [
    id,
    personId,
    SCAN_PERSON,
  ]);
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id, active)
     values ($1, $2, 'person', $3, true)`,
    [id, actorId, personId],
  );
  await tx.query(
    `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
    [id, loginId, subject],
  );
  await tx.query(
    `insert into public.person_logins (business_id, id, login_id, person_id, active, linked_by_actor_id)
     values ($1,$2,$3,$4,true,$5)`,
    [id, randomUUID(), loginId, personId, actorId],
  );
  await tx.query(
    `insert into public.memberships (business_id, id, person_id, role_key, active)
     values ($1,$2,$3,'member',true)`,
    [id, randomUUID(), personId],
  );
  for (const [collection, action] of SCAN_GRANTS) {
    // eslint-disable-next-line no-await-in-loop -- one per grant, in order, in one transaction
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'business', id: null },
      collection,
      action,
      parentGrantId: null,
      grantedByActorId: actorId,
    });
    if (!issued.ok) throw new Error(`grant refused ${issued.refusal.code}`);
  }
  return personId;
}

async function make() {
  if (existsSync(env.SCAN_LOGIN_FILE))
    stop('SCAN_LOGIN_FILE exists: remove the last scan login first');
  const email = scanEmail(randomBytes(6).toString('hex'));
  const password = randomBytes(24).toString('base64url');
  const made = await provider('/admin/users', 'POST', { email, password, email_confirm: true });
  const userId = made.body?.id;
  if (made.status >= 300 || typeof userId !== 'string')
    stop(`the admin API did not make the sign-in (${made.status})`);
  keep(env.SCAN_LOGIN_FILE, JSON.stringify({ email, userId }));

  const business = await businessId();
  const db = connect(env.DATABASE_URL, { source: 'scan-login' });
  try {
    await db.withBusiness(business, (tx) => member(tx, userId));
  } finally {
    await db.close();
  }

  const publishable = env.SUPABASE_PUBLISHABLE_KEY;
  const signedIn = await provider(
    '/token?grant_type=password',
    'POST',
    { email, password },
    publishable ? { apikey: publishable } : {},
  );
  const token = signedIn.body?.access_token;
  if (signedIn.status !== 200 || typeof token !== 'string')
    stop(`the scan login did not sign in (${signedIn.status})`);
  keep(env.SCAN_TOKEN_FILE, token);
  console.log(`scan-login: made ${email}, a member of ${SCAN_BUSINESS}, signed in`);
}

// Check first, then end what the sign-in is mapped to, found from its own login
// row and never from the file: a lost reply is found, a tampered file names no one.
async function endRows(record, providerEmail) {
  const db = connect(env.DATABASE_URL, { source: 'scan-login' });
  try {
    await db.withBusiness(await businessId(), async (tx) => {
      const mapped = await tx.query(
        `select pl.person_id, p.display_name from public.logins l
           join public.person_logins pl on pl.login_id = l.id
           join public.people p on p.id = pl.person_id
          where l.provider = 'supabase' and l.subject = $1`,
        [record.userId],
      );
      // The sign-in is checked even when nothing is mapped to it; each person too.
      const why = [undefined, ...mapped.map((row) => row.display_name)]
        .map((displayName) => removalRefusal({ email: record.email, providerEmail, displayName }))
        .find((each) => each !== undefined);
      if (why !== undefined) stop(why);
      for (const { person_id: personId } of mapped) {
        // eslint-disable-next-line no-await-in-loop -- one person, in one transaction
        await endPerson(tx, personId, record.userId);
      }
    });
  } finally {
    await db.close();
  }
}

/** As `access.end` ends a person (`access-end.ts`), and the login's mapping with it. */
async function endPerson(tx, personId, subject) {
  const actor = await tx.query(
    `select id from public.actors where person_id = $1 and kind = 'person'`,
    [personId],
  );
  await endPersonAuthority(tx, personId, actor[0]?.id ?? personId);
  await tx.query(
    `update public.memberships set active = false, ended_at = now()
      where business_id = $1 and person_id = $2::uuid and active`,
    [tx.businessId, personId],
  );
  await tx.query(
    `update public.actors set active = false, deactivated_at = now()
      where business_id = $1 and person_id = $2::uuid and kind = 'person' and active`,
    [tx.businessId, personId],
  );
  await tx.query(
    `update public.person_logins set active = false, deactivated_at = now()
      where person_id = $1::uuid and active and login_id in
        (select id from public.logins where provider = 'supabase' and subject = $2)`,
    [personId, subject],
  );
}

async function remove() {
  if (!existsSync(env.SCAN_LOGIN_FILE)) {
    console.log('scan-login: no scan login on record; nothing to remove');
    return;
  }
  const record = loginRecord(readFileSync(env.SCAN_LOGIN_FILE, 'utf8'));
  const found = await provider(`/admin/users/${record.userId}`, 'GET');
  if (found.status !== 200 && found.status !== 404)
    stop(`the admin API did not read the sign-in (${found.status})`);
  const providerEmail = found.status === 404 ? undefined : found.body?.email;
  if (found.status === 200 && typeof providerEmail !== 'string')
    stop('the admin API answered for the sign-in with no address; nothing was removed');

  await endRows(record, providerEmail);

  if (providerEmail !== undefined) {
    const gone = await provider(`/admin/users/${record.userId}`, 'DELETE');
    if (gone.status >= 300 && gone.status !== 404)
      stop(`the admin API did not delete the sign-in (${gone.status})`);
  }
  rmSync(env.SCAN_TOKEN_FILE, { force: true });
  rmSync(env.SCAN_LOGIN_FILE, { force: true });
  console.log(`scan-login: removed ${record.email}`);
}

try {
  if (args[0] === 'make') await make();
  else await remove();
} catch (error) {
  // A driver's message can carry an address, so anything not ours is named by kind and code.
  const code = /^[0-9A-Z]{5}$/u.test(error?.code ?? '') ? ` ${error.code}` : '';
  console.error(
    `scan-login: ${error instanceof Stopped ? error.message : `stopped (${error?.name ?? 'error'}${code})`}`,
  );
  process.exit(1);
}
