// SPDX-License-Identifier: AGPL-3.0-only
//
// S1-S2: the two operation-classified business settings, written from a real
// browser against the live API.
//
// **The seed grants nobody `settings:manage`, and this group says so out loud.**
// `scripts/local-seed.mjs` gives its admin `task` read/write/assign/comment/
// share/manage and `person:read`; the settings commands take `manage` on the
// `settings` collection (`commands/surface.ts`), which is a collection no
// seeded identity holds anything on. So S1 cannot run as the seed stands: it
// issues the grant itself through `issueGrant` -- the authority path, the same
// one `n6-revocation.mjs` uses to revoke one -- and takes it back in a
// `finally`, leaving the business's grants as it found them. The gap belongs to
// the seed's lane and is named in the handback rather than patched here.
//
// **The value is put back too.** `four_eyes_threshold` is a shared row, not a
// task this run created, so S1 restores it to what it read before it wrote.
//
// S2 needs no provisioning at all: mia holds nothing on `settings`, which is
// the point of the case.
//
// Run: node tests/browser/cases-settings.mjs  (or through slice-acceptance)

import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  VIEWPORT,
  WEB,
  closeQuietly,
  fromEnvFile,
  record,
  shot,
  signIn,
  standaloneStatus,
  users,
} from './harness.mjs';

const REQUIRED = ['S1', 'S2'];
const SAVE = '[data-settings="save-four-eyes"]';
const KNOWN = '[data-settings="four-eyes-known"]';

/**
 * The person behind a seeded login, found by the subject GoTrue minted.
 *
 * By the subject and not by a display name: the seed has been run more than
 * once against this database and a name matches whatever an earlier run left,
 * while a subject is the one thing the login and `.local/synthetic-users.json`
 * agree on.
 */
async function personOf(admin, businessId, email) {
  const subject = users.find((user) => user.email === email)?.subject;
  const rows = await admin.execute(
    `select pl.person_id, a.id as actor_id
       from public.logins l
       join public.person_logins pl on pl.login_id = l.id and pl.business_id = l.business_id
       join public.actors a on a.person_id = pl.person_id
      where l.business_id = $1 and l.provider = 'supabase' and l.subject = $2 and pl.active
      limit 1`,
    [businessId, subject],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no person for ${email} (subject ${String(subject)})`);
  return row;
}

/** `settings:manage` for as long as the case needs it, then taken back. */
async function withSettingsGrant(database, businessId, person, work) {
  const id = await database.withBusiness(businessId, async (tx) => {
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: person.person_id },
      scope: { kind: 'business', id: null },
      collection: 'settings',
      action: 'manage',
      parentGrantId: null,
      grantedByActorId: person.actor_id,
    });
    if (!issued.ok) throw new Error(`settings grant refused ${issued.refusal.code}`);
    return issued.value;
  });
  try {
    return await work();
  } finally {
    await database.withBusiness(businessId, async (tx) => revokeGrant(tx, id));
  }
}

/** What the row holds, read straight from the table: the API exposes no read. */
async function storedThreshold(admin, businessId) {
  const rows = await admin.execute(
    `select value from public.business_settings
      where business_id = $1 and key = 'four_eyes_threshold'`,
    [businessId],
  );
  return rows[0]?.value;
}

export async function casesSettings(run) {
  const context = await run.browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await settings(page, run);
  } finally {
    await context.close();
  }
}

async function settings(page, run) {
  const { database, admin, alpha } = run;
  const ada = await personOf(admin, alpha, 'ada@alpha.local');
  const was = await storedThreshold(admin, alpha);

  await signIn(page, 'ada@alpha.local', 'alpha');
  await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SAVE, { timeout: 15_000 });

  // The screen opens on "not known" and says why, because no declared read
  // carries these rows. That is a case of its own: a screen that opened on the
  // shipped default would be telling a person a number nobody asked for.
  const opened = await page.locator(KNOWN).innerText();
  const named = await page.locator('[data-settings="not-readable"]').count();
  record({
    case: 'S1 the screen opens on unknown and names the missing read',
    action: 'ada opened /settings',
    observed: `it says "${opened.trim()}" and ${named === 1 ? 'names' : 'does not name'} the absent read`,
    ok: opened.includes('not known') && named === 1,
    shot: await shot(page, 'S1-settings-unknown'),
  });

  await withSettingsGrant(database, alpha, ada, async () => {
    await page.fill('#settings-four-eyes', '1234');
    await page.click(SAVE);
    await page
      .waitForFunction(
        () =>
          document.querySelector('[data-settings="four-eyes-known"]')?.textContent.includes('1234'),
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => undefined);

    const confirmed = await page.locator(KNOWN).innerText();
    const stored = await storedThreshold(admin, alpha);
    record({
      case: 'S1 an admin sets the threshold and the row holds it',
      action: 'ada set the four-eyes threshold to 1234 with settings:manage in hand',
      observed: `the screen says "${confirmed.trim()}" and the row holds ${JSON.stringify(stored)}`,
      ok: confirmed.includes('1234') && String(stored) === '1234',
      shot: await shot(page, 'S1-threshold-written'),
    });

    // A hard reload: a new document. The value stands because the tab kept the
    // server's own confirmation, and the screen still says it is not a read.
    await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(KNOWN, { timeout: 15_000 });
    const after = await page.locator(KNOWN).innerText();
    const stillNamed = await page.locator('[data-settings="not-readable"]').count();
    const stillStored = await storedThreshold(admin, alpha);
    record({
      case: 'S1 it stands across a reload',
      action: 'hard-reloaded /settings',
      observed:
        `the screen says "${after.trim()}", the row still holds ${JSON.stringify(stillStored)}, ` +
        `and it ${stillNamed === 1 ? 'still says' : 'no longer says'} the value is not read back`,
      ok: after.includes('1234') && String(stillStored) === '1234' && stillNamed === 1,
      shot: await shot(page, 'S1-threshold-after-reload'),
    });

    // Put the shared row back where it was found.
    await page.fill('#settings-four-eyes', String(was));
    await page.click(SAVE);
    await page.waitForTimeout(800);
    return undefined;
  });

  const restored = await storedThreshold(admin, alpha);
  record({
    case: 'S1 the shared row is left as it was found',
    action: `wrote ${JSON.stringify(was)} back before giving the grant up`,
    observed: `the row holds ${JSON.stringify(restored)}`,
    ok: String(restored) === String(was),
  });

  await refusedMember(page, admin, alpha);
}

/** A member holding nothing on `settings`, asking once. */
async function refusedMember(page, admin, alpha) {
  await page.evaluate(() => {
    sessionStorage.clear();
  });
  const before = await storedThreshold(admin, alpha);

  await signIn(page, 'mia@alpha.local', 'alpha');
  await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SAVE, { timeout: 15_000 });

  const sent = [];
  page.on('request', (request) => {
    if (request.url().includes('/settings/')) sent.push(request.url());
  });

  await page.fill('#settings-four-eyes', '4321');
  await page.click(SAVE);
  await page
    .waitForSelector('[data-settings="refusal"]', { timeout: 15_000 })
    .catch(() => undefined);
  const quoted = await page
    .locator('[data-settings="refusal"]')
    .innerText()
    .catch(() => '');
  const afterFirst = sent.length;

  await page.click(SAVE, { force: true }).catch(() => undefined);
  await page.waitForTimeout(500);
  const disabled = await page.locator(SAVE).isDisabled();
  const signOffDisabled = await page.locator('[data-settings="save-sign-off"]').isDisabled();
  const after = await storedThreshold(admin, alpha);

  record({
    case: 'S2 a member is refused and the value is unchanged',
    action: 'mia opened /settings and tried to set the threshold to 4321, twice',
    observed:
      `the screen quoted "${quoted.slice(0, 80)}"; the controls are ` +
      `${disabled && signOffDisabled ? 'closed' : 'still open'}; the row went from ` +
      `${JSON.stringify(before)} to ${JSON.stringify(after)}; ` +
      `${String(afterFirst)} request(s) before the second press, ${String(sent.length)} after`,
    ok:
      quoted.includes('SCOPE_NOT_GRANTED') &&
      disabled &&
      signOffDisabled &&
      String(before) === String(after) &&
      afterFirst === 1 &&
      sent.length === 1,
    shot: await shot(page, 'S2-settings-refused'),
  });
}

// ------------------------------------------------------------------ standalone

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'settings-cases' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'settings-cases' });
  const rows = await admin.execute('select id from public.businesses where key = $1', ['alpha']);
  try {
    await casesSettings({
      browser,
      database,
      admin,
      alpha: rows[0]?.id,
      stamp: new Date().toISOString(),
      state: {},
    });
  } catch (error) {
    record({
      case: 'S run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
    await closeQuietly(database);
    await closeQuietly(admin);
  }
  process.exitCode = standaloneStatus('settings', REQUIRED);
}
