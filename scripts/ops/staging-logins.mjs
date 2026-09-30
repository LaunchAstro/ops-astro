// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging's database logins, the command (ticket S0-1, STAGING-PREP B3). The
// decisions are in `staging-logins.ts`; this file runs them.
//
//   node scripts/ops/staging-logins.mjs before-reset
//   node scripts/ops/staging-logins.mjs after-reset
//
// A person's act, typed into one Terminal window with STAGING_PROJECT_REF,
// PRODUCTION_PROJECT_REF (when production has a project), DATABASE_ADMIN_URL
// (the project's own login, through the Sydney session pooler) and
// OPS_LOGINS_DIR (a new folder, made owner-only). `before-reset` makes the app
// group and the runtime login; `after-reset`, once the reset has migrated, one
// login for each of the lookup, backup identity and forwarder groups. Each run
// sets fresh passwords and writes one owner-only file per setting, named after
// it and holding its whole address, for `vercel env add <NAME> production <
// file` and the M5's settings files; the owner then deletes the folder. It
// refuses a folder that exists, so no earlier address is overwritten. Exit 0
// when done, 1 when refused or stopped; nothing printed carries a value.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { loginAddresses, loginsRefusal, statementsFor } from './staging-logins.ts';

const env = process.env;
const args = process.argv.slice(2);

const named = (error) =>
  [error?.code === 'EEXIST' ? 'OPS_LOGINS_DIR exists' : (error?.name ?? 'error')]
    .concat(/^[0-9A-Z]{5}$/u.test(error?.code ?? '') ? [error.code] : [])
    .join(' ');

const refusal = loginsRefusal(env, args);
if (refusal !== undefined) {
  console.error(`staging-logins: refused: ${refusal}. Nothing was done.`);
  process.exit(1);
}

const [step] = args;
const addresses = loginAddresses(env.DATABASE_ADMIN_URL, env.STAGING_PROJECT_REF, step);
const admin = connectAsAdmin(env.DATABASE_ADMIN_URL, { source: 'logins' });
let stage = 'the check';
try {
  if (step === 'after-reset') {
    const groups = addresses.map(({ login }) => login.group);
    const found = await admin.execute('select rolname from pg_roles where rolname = any($1)', [
      groups,
    ]);
    if (found.length !== groups.length) {
      console.error(
        'staging-logins: refused: the reset has not made the groups yet. Nothing was done.',
      );
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    // Made before the database is touched: an existing folder refuses the run.
    stage = 'making the folder';
    mkdirSync(env.OPS_LOGINS_DIR, { mode: 0o700 });
    stage = 'making the logins';
    await admin.transaction(async (execute) => {
      // oxlint-disable-next-line no-await-in-loop -- in order: a grant needs its role
      for (const statement of statementsFor(step, addresses)) await execute(statement);
    });
    stage = 'writing the addresses';
    for (const { login, address } of addresses) {
      writeFileSync(join(env.OPS_LOGINS_DIR, login.setting), address, { mode: 0o600, flag: 'wx' });
    }
    const names = addresses.map(({ login }) => login.setting).join(', ');
    console.log(`staging-logins: ${step}: ${String(addresses.length)} login(s) set: ${names}`);
  }
} catch (error) {
  console.error(`staging-logins: stopped while ${stage} (${named(error)}).`);
  process.exitCode = 1;
} finally {
  await admin.close();
}
