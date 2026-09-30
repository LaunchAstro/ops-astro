// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging reset's command (ticket S0-1, STAGING-PREP B4). The decisions
// are in `staging-reset.ts`; this file runs them.
//
//   node scripts/ops/staging-reset.mjs
//
// A person's act with staging's own logins, typed into one Terminal window:
// STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF (when production has a project),
// DATABASE_ADMIN_URL (the migration login, through the session pooler),
// DATABASE_URL (the runtime login), GOTRUE_URL, SUPABASE_SERVICE_KEY (the
// provider's admin API key) and OPS_SEED_DIR (a new folder, made owner-only,
// for the made-up passwords and keys the owner puts in the password manager).
// It is not behind the operator gate: the first reset makes staging's operator.
//
// In order: every refusal that needs no connection; then, connected, a
// database neither marked made-up nor new is refused, and so are a service key
// the admin API does not accept (one read) and a record that is not a real
// file (a `started` line is written to it and read back); then the owner's
// folder is made; only then empty (the product's schemas and the made-up
// mark), migrate, make the sign-ins, seed (`scripts/local-seed.mjs`, which
// judges the database again and marks it) and write the installation's
// operating business once, and append the done line to the same record. Exit 0
// when done, 1 when refused or stopped. Nothing it prints carries an address,
// a password, a key or a project reference.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import { resettable } from './made-up-only.ts';
import { RECORD_FILE } from './operator.ts';
import {
  OPERATING_BUSINESS,
  Refusal,
  STAGING_CAST,
  refusalBeforeConnecting,
} from './staging-reset.ts';

const SEED = new URL('../local-seed.mjs', import.meta.url).pathname;
const MIGRATIONS = new URL('../../migrations', import.meta.url).pathname;
const env = process.env;

const EMPTY = [
  'drop schema if exists ops, ops_astro_made_up cascade',
  'drop schema if exists public cascade',
  'create schema public authorization pg_database_owner',
  'grant usage on schema public to public',
];

/** Every setting's value, and each login's parts, blanked out of what is printed. */
const secrets = [
  'STAGING_PROJECT_REF',
  'PRODUCTION_PROJECT_REF',
  'SUPABASE_SERVICE_KEY',
  'GOTRUE_URL',
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
].flatMap((name) => {
  const url = URL.parse(env[name] ?? '');
  return [env[name], url?.password, url?.username, url?.hostname].map((part) => {
    try {
      return decodeURIComponent(part ?? '');
    } catch {
      return part;
    }
  });
});
const redact = (text) =>
  secrets
    .filter((secret) => typeof secret === 'string' && secret.length >= 4)
    .reduce((out, secret) => out.replaceAll(secret, '[a setting]'), text);

/** An error by its class and SQLSTATE alone: its message may carry an address. */
const named = (error) =>
  [error?.name ?? 'error', /^[0-9A-Z]{5}$/u.test(error?.code ?? '') ? error.code : '']
    .filter(Boolean)
    .join(' ');

function refuse(why) {
  console.error(`staging-reset: ${why}. Nothing was done.`);
  process.exit(1);
}

/** One made-up sign-in through the admin API, confirmed as made, so no mail goes. */
async function signIn(member, password) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = {
    authorization: `Bearer ${key}`,
    apikey: key,
    'content-type': 'application/json',
  };
  const call = async (path, method, body) => {
    const response = await fetch(`${env.GOTRUE_URL}${path}`, {
      method,
      headers,
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: response.ok, body: await response.json().catch(() => ({})) };
  };
  const confirmed = { email: member.email, password, email_confirm: true };
  const made = await call('/admin/users', 'POST', confirmed);
  if (made.ok && typeof made.body?.id === 'string') return made.body.id;
  // Already there from an earlier reset: its password is made again.
  const listed = await call('/admin/users?page=1&per_page=200', 'GET');
  const users = Array.isArray(listed.body?.users) ? listed.body.users : [];
  const id = users.find((user) => user.email === member.email)?.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id))
    throw new Refusal(`the admin API did not make the sign-in ${member.email}`);
  if (!(await call(`/admin/users/${id}`, 'PUT', confirmed)).ok)
    throw new Refusal(`the admin API did not reset the sign-in ${member.email}`);
  return id;
}

/** The admin API takes the key: one sign-in read, before anything is emptied. */
async function keyAccepted() {
  const key = env.SUPABASE_SERVICE_KEY;
  try {
    const response = await fetch(`${env.GOTRUE_URL}/admin/users?page=1&per_page=1`, {
      headers: { authorization: `Bearer ${key}`, apikey: key },
      redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The run's record, proved before anything is emptied: a real file in a real
 * folder (no link, device, pipe or folder in its place), opened without
 * following a link, with a `started` line written and read back through the
 * same handle. The handle, or undefined when the record cannot hold the run.
 */
function openRecord() {
  const path = join(env.OPS_ASTRO_DEPLOYMENTS, RECORD_FILE);
  try {
    mkdirSync(env.OPS_ASTRO_DEPLOYMENTS, { recursive: true, mode: 0o700 });
    if (!lstatSync(env.OPS_ASTRO_DEPLOYMENTS).isDirectory()) return;
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile() === false) return;
    const { O_RDWR, O_APPEND, O_CREAT, O_NOFOLLOW } = constants;
    const handle = openSync(path, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    const line = Buffer.from(
      `${JSON.stringify({ action: 'staging reset', stage: 'started', at: new Date().toISOString() })}\n`,
    );
    const back = Buffer.alloc(line.length);
    if (fstatSync(handle).isFile()) {
      writeSync(handle, line);
      readSync(handle, back, 0, line.length, fstatSync(handle).size - line.length);
    }
    if (back.equals(line)) return handle;
    closeSync(handle);
  } catch {
    // Anything the record cannot do is a refusal below.
  }
}

const why = refusalBeforeConnecting(env, process.argv.slice(2));
if (why !== undefined) refuse(why);
const folder = env.OPS_SEED_DIR;
if (existsSync(folder))
  refuse(
    'OPS_SEED_DIR already exists: name a new folder, so nothing local is carried into staging',
  );

let step = 'the check';
let migrations = 0;
let record;
const admin = connectAsAdmin(env.DATABASE_ADMIN_URL, { source: 'reset' });
try {
  if (!(await resettable(admin)))
    refuse('the database is neither marked made-up nor new, so it may hold real data');
  // Every precondition before anything is emptied: a refusal empties and records nothing.
  if (!(await keyAccepted())) refuse('the admin API did not accept SUPABASE_SERVICE_KEY');
  record = openRecord();
  if (record === undefined)
    refuse('the record in OPS_ASTRO_DEPLOYMENTS is not a file it can write');
  mkdirSync(folder, { mode: 0o700 });
  step = 'emptying';
  // oxlint-disable-next-line no-await-in-loop -- in order: each builds on the one before
  for (const statement of EMPTY) await admin.execute(statement);
  const [unmark] = await admin.execute(
    "select format('comment on database %I is null', current_database()) as statement",
  );
  await admin.execute(unmark.statement);
  console.log('staging-reset: emptied');
  step = 'migrating';
  const { applied } = await migrate(admin, MIGRATIONS);
  console.log(`staging-reset: ${applied.length} migrations applied`);
  migrations = applied.length;
} catch (error) {
  await admin.close();
  console.error(`staging-reset: stopped while ${step} (${named(error)}); run it again.`);
  process.exit(1);
}
await admin.close();

try {
  step = 'making the sign-ins';
  const users = [];
  for (const member of STAGING_CAST) {
    const password = randomBytes(18).toString('base64url');
    // oxlint-disable-next-line no-await-in-loop -- one person at a time, in the cast's order
    users.push({ ...member, password, subject: await signIn(member, password) });
  }
  writeFileSync(join(folder, 'synthetic-users.json'), `${JSON.stringify(users, undefined, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`staging-reset: ${users.length} made-up sign-ins, confirmed as made, no mail sent`);

  step = 'seeding';
  // Under the reset's own Node flags, so the seed runs as the reset does.
  const seeded = spawnSync(process.execPath, [...process.execArgv, SEED], {
    encoding: 'utf8',
    env: {
      PATH: env.PATH ?? '',
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL,
      GOTRUE_URL: env.GOTRUE_URL,
      SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY,
      OPS_SEED_DIR: folder,
      LOCAL_SEED_MADE_UP: 'confirm',
    },
  });
  process.stdout.write(redact(seeded.stdout ?? ''));
  if (seeded.status !== 0) {
    process.stderr.write(redact(seeded.stderr ?? ''));
    throw new Refusal('the seed did not finish');
  }

  step = 'writing the operating business';
  const installation = connectAsAdmin(env.DATABASE_ADMIN_URL, { source: 'reset' });
  try {
    await installation.execute(
      `insert into ops.operating_business (operating_business)
         select id from public.businesses where key = $1`,
      [OPERATING_BUSINESS],
    );
  } finally {
    await installation.close();
  }
  const operator = STAGING_CAST.find((member) => member.grants?.length === 1);
  // Each run is recorded where the other operator acts are, and names no setting's value.
  step = 'recording the run';
  const done = { action: 'staging reset', migrations, signIns: users.length };
  appendFileSync(record, `${JSON.stringify({ ...done, at: new Date().toISOString() })}\n`);
  closeSync(record);
  console.log(
    `staging-reset: the operating business is ${OPERATING_BUSINESS}; ` +
      `its made-up operator is ${operator?.email}`,
  );
  console.log(
    'staging-reset: done. The made-up passwords and keys are in OPS_SEED_DIR, owner only: ' +
      'put them in the password manager entry "Ops Astro staging", then delete the folder.',
  );
} catch (error) {
  const said = error instanceof Refusal ? error.message : named(error);
  console.error(`staging-reset: stopped while ${step} (${said}); empty and run it again.`);
  process.exit(1);
}
