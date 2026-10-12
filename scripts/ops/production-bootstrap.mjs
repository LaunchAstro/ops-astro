// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's bootstrap, the command. The decisions are in
// `production-bootstrap.ts`; this file runs them.
//
//   node scripts/ops/production-bootstrap.mjs --business-key <key> \
//     --business-name <name> --owner-name <name> --owner-subject <sign-in id>
//
// A person's act, run once, with PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF
// and DATABASE_ADMIN_URL (production's owner login, TLS required) set
// (deploy/production/README.md). Exit 0 when done, 1 when refused or stopped;
// a stop rolls everything back. Nothing printed carries an address or a key.

import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { bootstrap, bootstrapInput } from './production-bootstrap.ts';
import { Refusal } from './staging-reset.ts';

const input = bootstrapInput(process.env, process.argv.slice(2));
if ('refusal' in input) {
  console.error(`production-bootstrap: refused: ${input.refusal}. Nothing was done.`);
  process.exit(1);
}

// Test-only: set by tests/support/plaintext-at-loopback.mjs for a throwaway
// server with no TLS; no setting or environment can set it.
const reach = new URL(process.env.DATABASE_ADMIN_URL);
if (globalThis[Symbol.for('ops-astro.test.plaintext-at-loopback')] === true) {
  reach.searchParams.set('sslmode', 'disable');
}
const admin = connectAsAdmin(reach.toString(), { source: 'bootstrap' });
try {
  const made = await bootstrap(admin, input.owner);
  console.log(
    `production-bootstrap: done. Business ${input.owner.businessKey} (${made.businessId}) ` +
      `operates this installation; its owner is an admin holding ${made.grants} grants.`,
  );
} catch (error) {
  if (error instanceof Refusal) {
    console.error(`production-bootstrap: refused: ${error.message}. Nothing was done.`);
  } else {
    // A database error's own words can quote a value; its code cannot.
    const code = /^[0-9A-Z]{5}$/u.test(error?.code ?? '') ? ` (${error.code})` : '';
    console.error(`production-bootstrap: stopped${code}; nothing was kept.`);
  }
  process.exitCode = 1;
} finally {
  await admin.close();
}
