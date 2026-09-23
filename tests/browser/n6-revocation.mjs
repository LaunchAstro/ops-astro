// SPDX-License-Identifier: AGPL-3.0-only
//
// Checklist N6, both halves, against the mounted application.
//
// **Half one, the revocation.** A person has a task open. Their `task:read`
// grant is revoked through the authority boundary -- `revokeGrant`, the same
// call the product would make -- while the page stays mounted. They press
// Refresh. The screen must reach `denied` and hold no task fields.
//
// The reread is a press, not a navigation. `page.goto` builds a new document,
// which throws away the projection under test along with everything else on the
// page; a denial drawn by a freshly mounted screen says nothing about whether
// the mounted one could be made to keep authorised content. That is the
// difference between this file and the earlier attempt.
//
// **Half two, the ordering.** An authorised response, taken from the real API
// while the grant was still live, is held at the network and released after a
// later read has come back denied. The application's own projection must refuse
// it: an older answer cannot restore authorised content over a denial, however
// true that answer was when it was taken. The response is held with
// `page.route`, so both reads are the mounted screen's own, started by two
// presses of the same button, over the real client and the real API.
//
// Nothing here is a test-only hook in the product. The only thing the product
// grew for this is the Refresh control, which is an ordinary control a person
// uses.
//
// Run: node tests/browser/n6-revocation.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:5190';

/** Progress, on stderr, so a run that stalls says where it stalled. */
const step = (what) => {
  process.stderr.write(`n6: ${what}\n`);
};

/** The one request this case holds: the task read the mounted screen makes. */
const isTaskRead = (url) => url.pathname.endsWith('/task/read');

/**
 * The person a login belongs to, derived from the login itself.
 *
 * The display name is not an identifier. The earlier attempt revoked grants for
 * a person called `Mia Alpha`, who does not exist -- `mia@alpha.local` is
 * `Mia Chen` -- so it revoked nothing and then reported that the page failed to
 * notice. This walks the subject the seed records for the login through
 * `public.logins` and `public.person_logins`, which is where the answer is.
 */
export async function personOfLogin(admin, businessId, provider, subject) {
  const rows = await admin.execute(
    `select pl.person_id
       from public.person_logins pl
       join public.logins l on l.id = pl.login_id and l.business_id = pl.business_id
      where pl.business_id = $1 and l.provider = $2 and l.subject = $3 and pl.active
      limit 1`,
    [businessId, provider, subject],
  );
  return rows[0]?.person_id;
}

/** Revoke every live `task:read` grant a person holds, through the authority path. */
export async function revokeTaskRead(database, businessId, personId) {
  return await database.withBusiness(businessId, async (tx) => {
    const live = await tx.query(
      `select id from public.grants
        where subject_kind = 'person' and subject_id = $1
          and collection = 'task' and action = 'read' and revoked_at is null`,
      [personId],
    );
    const revoked = [];
    for (const grant of live) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one row at a time.
      await revokeGrant(tx, grant.id);
      revoked.push(grant.id);
    }
    return revoked;
  });
}

/**
 * Both halves, on a page already showing the task.
 *
 * `shot(name)` takes a screenshot and returns its path. Returns the two records
 * the caller writes into its results table.
 */
export async function n6Cases(given) {
  const { page, database, admin, businessId, login, shot } = given;
  const out = [];

  step('looking the person up from the login');
  const personId = await personOfLogin(admin, businessId, login.provider, login.subject);
  if (personId === undefined) throw new Error(`no person for login subject ${login.subject}`);

  step('opened, waiting for the task');
  await page.waitForSelector('[data-task]', { timeout: 20_000 });
  await page.waitForSelector('[data-refresh="task"]', { timeout: 20_000 });
  const authorisedShot = await shot('N6-authorised');

  // ---------------------------------------------------------------- half two,
  // set up first: the authorised response must be taken while the grant is
  // still live, and it is the first read the held route sees.
  let held;
  let heldBody;
  let seen = 0;
  step('installing the hold on task.read');
  await page.route(isTaskRead, async (route) => {
    seen += 1;
    if (seen === 1) {
      // Goes to the real API now, with the grant live, and is kept.
      const response = await route.fetch();
      heldBody = await response.text();
      held = route;
      return;
    }
    await route.continue();
  });

  // Press one: the read leaves, reaches the API, and is held at the wire.
  step('press one: a read that will be held');
  await page.click('[data-refresh="task"]');
  await page.waitForSelector('[data-outcome="loading"]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('[data-refresh="task"]') !== null);

  // ---------------------------------------------------------------- half one
  step('revoking through revokeGrant');
  const revoked = await revokeTaskRead(database, businessId, personId);

  // Press two, while press one is still in flight. The Refresh control is
  // outside the read's region, so it survives the loading rendering; this is
  // the overlap the case needs and the reason the control exists.
  await page.click('[data-refresh="task"]');
  step('press two: waiting for the denial');
  await page.waitForSelector('[data-outcome="denied"]', { timeout: 20_000 });
  const deniedText = await page.locator('[data-outcome="denied"]').first().innerText();
  const fieldsAfterDenial = await page.locator('[data-task]').count();
  out.push({
    case: 'N6 revocation on the mounted page',
    action:
      `revoked ${String(revoked.length)} live task:read grant(s) for the person behind ` +
      `${login.email} (derived through public.logins/person_logins, not a display name) ` +
      `through revokeGrant, with /task/ open, then pressed Refresh -- no navigation`,
    observed:
      `the mounted document drew data-outcome="denied" quoting ` +
      `${JSON.stringify(deniedText.replace(/\s+/gu, ' ').slice(0, 90))}; ` +
      `${String(fieldsAfterDenial)} task field region(s) remain`,
    ok: revoked.length > 0 && /SCOPE_NOT_GRANTED/u.test(deniedText) && fieldsAfterDenial === 0,
    shot: await shot('N6-denied-after-revocation'),
    extra: { authorised: authorisedShot },
  });

  // ------------------------------------------------- half two, the release
  step('releasing the held authorised response');
  const heldWasAuthorised = heldBody !== undefined && !/SCOPE_NOT_GRANTED/u.test(heldBody);
  if (held !== undefined) {
    await held.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: heldBody,
    });
  }
  // Give the released response every chance to land and draw.
  await page.waitForTimeout(1500);
  const outcomeAfter = await page.locator('[data-outcome]').first().getAttribute('data-outcome');
  const fieldsAfterRelease = await page.locator('[data-task]').count();
  out.push({
    case: 'N6 an older in-flight response cannot restore',
    action:
      `an authorised task.read taken from the API before the revocation was held at the ` +
      `network, the later read returned the denial, then the old response was released to ` +
      `the same mounted projection`,
    observed:
      `the held response was ${heldWasAuthorised ? 'authorised' : 'NOT authorised'}; ` +
      `after releasing it the screen is data-outcome="${outcomeAfter}" with ` +
      `${String(fieldsAfterRelease)} task field region(s)`,
    ok: heldWasAuthorised && outcomeAfter === 'denied' && fieldsAfterRelease === 0,
    shot: await shot('N6-older-response-refused'),
  });

  await page.unroute(isTaskRead);
  return { records: out, personId, revoked };
}

// ------------------------------------------------------------------ standalone

function fromEnvFile(name) {
  if (process.env[name]) return process.env[name];
  for (const line of readFileSync(`${root}.local/db.env`, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.+)$`, 'u').exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const SHOTS =
    process.env.SHOT_DIR ??
    `${root}../ops-astro-roadmap/.local/ops-astro-build-run-2026-09-23/parent-observations/local-slice`;
  const users = JSON.parse(readFileSync(`${root}.local/synthetic-users.json`, 'utf8'));
  const login = users.find((user) => user.email === 'mia@alpha.local');

  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'n6-revocation' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'n6-revocation' });
  const businessId = (
    await admin.execute('select id from public.businesses where key = $1', ['alpha'])
  )[0]?.id;

  const context = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const page = await context.newPage();
  const shot = async (name) => {
    const file = `${SHOTS}/${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };

  try {
    step('signing in');
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#signin-email');
    await page.fill('#signin-email', login.email);
    await page.fill('#signin-password', login.password);
    await page.selectOption('#signin-business', login.businessKey);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });

    // A task this person can already read. N6 is about the grant, not about
    // creating anything, so it opens the first row on their own board.
    step('finding a task on the board');
    const row = page.locator('a[href^="/task/"]').first();
    await row.waitFor({ timeout: 20_000 });
    const taskKey = decodeURIComponent((await row.getAttribute('href')).replace('/task/', ''));
    await row.click();

    const { records, personId, revoked } = await n6Cases({
      page,
      database,
      admin,
      businessId,
      login,
      shot,
    });
    console.log(`\ntask ${taskKey}, person ${personId}, grants revoked: ${revoked.join(', ')}`);
    for (const entry of records) {
      console.log(`${entry.ok ? 'pass ' : 'FAIL '} ${entry.case}\n        ${entry.observed}`);
    }
    console.log(JSON.stringify(records, undefined, 2));
    process.exitCode = records.every((entry) => entry.ok) ? 0 : 1;
  } catch (error) {
    step(`stopped: ${String(error).slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await database.end?.();
    await admin.end?.();
    // The pools keep the loop alive; the evidence is already written.
    process.exit(process.exitCode ?? 0);
  }
}
