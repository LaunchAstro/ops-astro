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
// its spending cap, two runs whose outcome nobody knows yet, and a helper the
// agent handed part of its work to. What each is, and how it is made, is in
// `click-through-work.mjs`.
//
// This file decides whether it may write at all. It refuses a database the
// made-up check does not admit, one DATABASE_URL does not reach, and one
// local-seed has not seeded. Exit 0 when seeded or already seeded, 1 when
// refused.

import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { admitMadeUp, bindSeed } from './made-up-only.ts';
import { ADMIN, BUSINESS, MEMBER, seedClickThrough } from './click-through-work.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
// The folder local-seed writes its keys to (OPS_SEED_DIR on staging).
const local = process.env['OPS_SEED_DIR'] || `${root}.local`;
const fromEnvFile = (name) =>
  process.env[name] || readEnvFile(`${local}/db.env`)[name] || undefined;

/** A refusal this script names, as against a fault it did not expect. */
class Refusal extends Error {}

const adminUrl = fromEnvFile('DATABASE_ADMIN_URL');
const appUrl = fromEnvFile('DATABASE_URL');
if (!adminUrl || !appUrl) {
  console.error(
    'click-through-seed: no DATABASE_URL/DATABASE_ADMIN_URL. Run scripts/local/db-up.sh.',
  );
  process.exit(1);
}

// Decisions are signed with the key local-seed keeps, and delegation
// credentials derived under its keyring, unless the environment names others.
const gate = readEnvFile(`${local}/gate.env`);
process.env['GATE_SIGNING_KEY_ID'] ||= gate['GATE_SIGNING_KEY_ID'] ?? '';
process.env['GATE_SIGNING_SECRET'] ||= gate['GATE_SIGNING_SECRET'] ?? '';
const keyFile = `${local}/delegation.env`;
const keyed = Boolean(process.env['DELEGATION_CREDENTIAL_KEY_ID']);
if (!keyed) process.env['DELEGATION_CREDENTIAL_KEY_FILE'] ||= keyFile;

// Staging holds made-up data only (S0-1), admitted as local-seed admits it,
// except that an unmarked database is never confirmed here: the cast must be
// there already, and local-seed marks the database it seeds.
const admin = connectAsAdmin(adminUrl, { source: 'seed' });
await bindSeed(admin);
const signs = await admitMadeUp(admin, false);
if (signs.length > 0) {
  console.error(`click-through-seed: REFUSED, not provably made-up data: ${signs.join('; ')}.`);
  await admin.close();
  process.exit(1);
}
// The work goes through DATABASE_URL, so it must reach the database just
// judged: a lock the admin connection holds, under a key no one else knows,
// is seen there (pg_locks names its database). local-seed's check, as is.
const database = connect(appUrl, { source: 'seed' });
const sameDatabase = await admin.transaction(async (execute) => {
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

try {
  if (!sameDatabase) throw new Refusal('DATABASE_URL does not reach the database judged above.');
  if (!process.env['GATE_SIGNING_SECRET'] || (!keyed && !existsSync(keyFile))) {
    throw new Refusal(`no gate or delegation key in ${local}: run local-seed first.`);
  }
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
