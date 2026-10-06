// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's click-through (SR-1): made-up work on top of the cast.
//
//   node scripts/ops/click-through-seed.mjs     (pnpm seed:click-through)
//
// `scripts/local-seed.mjs` seeds the people, logins, grants and agents and
// never a task, and the acceptance cases depend on that. This is the second,
// separate step a staging reset runs after it, so the owner has something to
// click: tasks across three made-up clients in each state, an untitled task,
// a worker's proposal waiting for approval, finished work, a run parked at
// its spending cap, two runs whose outcome nobody knows yet, a helper the
// agent handed part of its work to, Ada's question to the agent with its
// reply kept, for the side panel, and a Wayfinder map with its tickets,
// frontier and fog (`click-through-work.mjs` makes them).
//
// This file decides whether it may write at all: it refuses a database the
// made-up check does not admit, one DATABASE_URL does not reach, and one
// local-seed has not seeded. Exit 0 when seeded or already seeded, 1 refused.

import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { configuredCredentialKeys } from '../../packages/core-records/src/authority/credential-keys.ts';
import { productionSigns } from './made-up-only.ts';
import { ADMIN, BUSINESS, MEMBER, Refusal, seedClickThrough } from './click-through-work.mjs';

/** The run's own advisory lock, held by the admin session for the whole run. */
const LOCK = 'ops-astro click-through seed';

const root = fileURLToPath(new URL('../..', import.meta.url));
// The folder local-seed writes its keys to (OPS_SEED_DIR on staging).
const local = process.env['OPS_SEED_DIR'] || `${root}.local`;
const fromEnvFile = (name) =>
  process.env[name] || readEnvFile(`${local}/db.env`)[name] || undefined;

const adminUrl = fromEnvFile('DATABASE_ADMIN_URL');
const appUrl = fromEnvFile('DATABASE_URL');
if (!adminUrl || !appUrl) {
  console.error(
    'click-through-seed: no DATABASE_URL/DATABASE_ADMIN_URL. Run scripts/local/db-up.sh.',
  );
  process.exit(1);
}

/** Refused, with nothing written: every refusal comes before the first write. */
function refuse(why) {
  console.error(`click-through-seed: REFUSED, ${why}`);
  process.exit(1);
}

// The keys before any connection. The gate key is a pair from one source,
// the environment or local-seed's file, never half of each.
const fileGate = readEnvFile(`${local}/gate.env`);
const envGate = ['GATE_SIGNING_KEY_ID', 'GATE_SIGNING_SECRET'].map((name) => process.env[name]);
const [gateId, gateSecret] = envGate.some(Boolean)
  ? envGate
  : [fileGate['GATE_SIGNING_KEY_ID'], fileGate['GATE_SIGNING_SECRET']];
if (!gateId || !gateSecret) refuse(`no whole gate signing key, in the environment or ${local}.`);
process.env['GATE_SIGNING_KEY_ID'] = gateId;
process.env['GATE_SIGNING_SECRET'] = gateSecret;
// The delegation keyring as the API reads it, from a file that is already
// there: `configuredCredentialKeys` makes one that is absent, and a keyring
// made here would not be the deployment's.
const explicit = ['DELEGATION_CREDENTIAL_KEY_ID', 'DELEGATION_CREDENTIAL_KEYS'].some(
  (name) => (process.env[name] ?? '') !== '',
);
if (!explicit) {
  process.env['DELEGATION_CREDENTIAL_KEY_FILE'] ||= `${local}/delegation.env`;
  if (!existsSync(process.env['DELEGATION_CREDENTIAL_KEY_FILE'])) {
    refuse("no delegation keyring file: run local-seed first, or name the deployment's.");
  }
}
const keyring = configuredCredentialKeys();
if (!keyring.ok) refuse(`the delegation keyring: ${keyring.problem}`);

// Staging holds made-up data only (S0-1): judged as local-seed judges it, and
// only judged. The guard is local-seed's to install, so this neither binds a
// seed tag nor rebuilds it, and an unmarked database is never confirmed here.
const admin = connectAsAdmin(adminUrl, { source: 'seed' });
const database = connect(appUrl, { source: 'seed' });
try {
  const signs = await productionSigns(admin, [], false);
  if (signs.length > 0) throw new Refusal(`not provably made-up data: ${signs.join('; ')}.`);
  if (!(await sameDatabase())) {
    throw new Refusal('DATABASE_URL does not reach the database judged above.');
  }
  const role = await appRole();
  if (role !== undefined) throw new Refusal(`DATABASE_URL's role ${role}.`);
  // One run at a time, for the whole run: the lock is the admin session's.
  const [held] = await admin.execute(`select pg_try_advisory_lock(hashtext($1)) as held`, [LOCK]);
  if (held?.held !== true) throw new Refusal('another click-through seed is running.');
  const made = await seedClickThrough(database, await readCast());
  console.log(
    `click-through-seed: ${BUSINESS} ` +
      (made.length === 0
        ? 'already seeded, nothing made'
        : `made ${String(made.length)}: ${made.join('; ')}`),
  );
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(`click-through-seed: REFUSED, ${error.message}`);
  process.exitCode = 1;
} finally {
  await database.close();
  await admin.close();
}

/**
 * Whether DATABASE_URL reaches the database just judged: a lock the admin
 * connection holds, under a key no one else knows, is seen there (pg_locks
 * names its database). local-seed's check, as is.
 */
async function sameDatabase() {
  return await admin.transaction(async (execute) => {
    const key = [randomInt(2 ** 31), randomInt(2 ** 31)];
    await execute('select pg_advisory_xact_lock($1, $2)', key);
    const [row] = await database.withBusiness(randomUUID(), (tx) =>
      tx.query(
        `select exists (select from pg_locks where locktype = 'advisory' and granted
            and database = (select oid from pg_database where datname = current_database())
            and classid = $1::int::oid and objid = $2::int::oid and objsubid = 2) as seen`,
        key,
      ),
    );
    return row?.seen === true;
  });
}

/**
 * What lets DATABASE_URL's role past row security, or nothing: the work must
 * run as the application does, so the policies judge it and the guard does
 * not take it for an owner's write (the rule `tenancy/privileges.ts` checks).
 */
async function appRole() {
  const [row] = await database.withBusiness(randomUUID(), (tx) =>
    tx.query(
      `select r.rolsuper, r.rolbypassrls, pg_has_role(current_user, d.datdba, 'member') as owner
         from pg_roles r, pg_database d
        where r.rolname = current_user and d.datname = current_database()`,
    ),
  );
  if (row === undefined) return 'cannot be read';
  if (row.rolsuper) return 'is a superuser';
  if (row.rolbypassrls) return 'bypasses row security';
  if (row.owner) return 'is a member of the database owner';
}

/** The business, its two people and its agent, as local-seed left them. */
async function readCast() {
  const [business] = await admin.execute('select id from public.businesses where key = $1', [
    BUSINESS,
  ]);
  if (business === undefined) throw new Refusal(`no '${BUSINESS}' business: run local-seed first.`);
  return await database.withBusiness(business.id, async (tx) => {
    const people = await tx.query(
      `select p.display_name as name, a.id as actor_id, l.subject
         from public.people p
         join public.actors a on a.business_id = p.business_id and a.person_id = p.id
         join public.person_logins pl on pl.business_id = p.business_id and pl.person_id = p.id
         join public.logins l on l.id = pl.login_id
        where p.business_id = $1 and p.display_name = any($2) and pl.active`,
      [tx.businessId, [ADMIN, MEMBER]],
    );
    // The seeded agent, never the helper this script adds beside it.
    const [agent] = await tx.query(
      `select a.id, l.subject from public.actors a
         join public.actor_logins al on al.business_id = a.business_id and al.actor_id = a.id
         join public.logins l on l.id = al.login_id
        where a.business_id = $1 and a.kind = 'agent' and l.subject not like 'click-through-%'
        order by a.id limit 1`,
      [tx.businessId],
    );
    const byName = new Map(people.map((row) => [row.name, row]));
    if (!byName.has(ADMIN) || !byName.has(MEMBER) || agent === undefined) {
      throw new Refusal(`the cast of '${BUSINESS}' is not seeded: run local-seed first.`);
    }
    const now = Math.floor(Date.now() / 1000);
    const person = (name) => ({
      provider: 'supabase',
      subject: byName.get(name).subject,
      assurance: { level: 'aal2', signedInAt: now, factorAt: now },
    });
    return {
      businessId: business.id,
      people: { [ADMIN]: person(ADMIN), [MEMBER]: person(MEMBER) },
      adminActorId: byName.get(ADMIN).actor_id,
      agent: { provider: 'supabase', subject: agent.subject },
    };
  });
}
