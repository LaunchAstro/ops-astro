// SPDX-License-Identifier: AGPL-3.0-only
//
// The acceptance checklist, driven through a real browser against the running
// slice: B1-B7 and N1-N7, plus the two review findings' browser cases, one
// decisive screenshot each.
//
// It is a script rather than a test file because it is evidence, not a check.
// It restarts the API and the database container, it revokes a live grant and
// puts it back, and it writes a results table a person reads; a test runner
// would give it a worker pool and a working directory it does not want. The
// suites under `tests/` stay the checks.
//
// This file is the order the cases run in and nothing else. Each group lives
// next to it in its own module, and they share only `harness.mjs` and the run
// context built below. The order is not decoration:
//
//   - B6 and B7 stop the API and the database container, so they go last.
//   - N6 revokes a live grant and holds a read taken before it, so nothing
//     else may churn grants in front of it: D1 does, and so D1 follows it.
//   - R1 makes the task D1 then edits, so R1 comes first of the two.
//
// **Nothing here seeds a task.** Every record it reasons about is one it
// created during the run, with a title carrying the run's own timestamp, so a
// row already in the database cannot make a case pass.
//
// Run: node tests/browser/slice-acceptance.mjs  (or `pnpm verify:browser`)

import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { VIEWPORT, closeQuietly, fromEnvFile, record, writeResults } from './harness.mjs';
import { casesB1toB4, casesB5 } from './cases-b.mjs';
import { casesN3toN5 } from './cases-n3-n5.mjs';
import { caseN7, casesN6 } from './cases-n6-n7.mjs';
import { casesCreateRetry } from './cases-create-retry.mjs';
import { casesTaskDrafts } from './cases-task-drafts.mjs';
import { casesSessionExpiry } from './cases-session-expiry.mjs';
import { casesComments } from './cases-comments.mjs';
import { casesSettings } from './cases-settings.mjs';
import { casesCapabilitiesDenied } from './capabilities-denied.mjs';
import { casesProposals } from './cases-proposals.mjs';
import { casesN1toN2 } from './cases-n1-n2.mjs';
import { casesB6toB7 } from './cases-b6-b7.mjs';

const stamp = new Date().toISOString();
const browser = await chromium.launch();
const database = connect(fromEnvFile('DATABASE_URL'), { source: 'browser-acceptance' });
// Plain lookups -- which business, which person -- are not tenant reads and go
// through the admin connection, exactly as the seed's do.
const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'browser-acceptance' });

const businessIdOf = async (key) => {
  const rows = await admin.execute('select id from public.businesses where key = $1', [key]);
  return rows[0]?.id;
};

/** What one case group leaves for the next: the run's own records. */
const state = { taskKey: undefined, taskId: undefined, edited: undefined, due: undefined };

try {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const run = {
    browser,
    page,
    database,
    admin,
    alpha: await businessIdOf('alpha'),
    stamp,
    title: `Acceptance ${stamp}`,
    state,
  };

  await casesB1toB4(run);
  await casesN3toN5(run);
  await caseN7(run);
  await casesB5(run);
  await casesCreateRetry(run);
  await casesN1toN2(run);
  await casesN6(run);
  await casesTaskDrafts(run);
  await casesSessionExpiry(run);
  // C and S come after SX and before B6/B7. After SX because each opens a
  // context of its own and neither wants the previous group's session; before
  // B6/B7 because those stop the API and the database container, and a group
  // that needs either cannot follow them.
  //
  // **S issues and revokes a grant**, so it must not sit in front of N6, which
  // holds a read taken before a revocation and cannot have grants churning
  // under it. Here it is well behind it.
  await casesComments(run);
  await casesSettings(run);
  await casesCapabilitiesDenied(run);
  // P after S for the same two reasons, and one of its own: it issues
  // `task:decide` and revokes it, so like S it must stay well behind N6, which
  // holds a read taken before a revocation and cannot have grants churning
  // under it.
  await casesProposals(run);
  await casesB6toB7(run);
  await context.close();
} catch (error) {
  record({
    case: 'run',
    action: 'the script itself',
    observed: `threw: ${String(error).slice(0, 400)}`,
    ok: false,
  });
} finally {
  await browser.close();
  // B6 closes both before it stops the container, so a second close is
  // ordinary here and must not hide the other pool's failure.
  await closeQuietly(database);
  await closeQuietly(admin);
}

// Zero only when every row passed. `writeResults` returns the rows that did
// not — failed, pending and unrun alike — so an incomplete run cannot leave
// this command looking like an accepted one.
const short = writeResults({ stamp, taskKey: state.taskKey, taskId: state.taskId });
process.exit(short === 0 ? 0 : 1);
