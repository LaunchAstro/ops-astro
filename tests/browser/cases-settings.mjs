// SPDX-License-Identifier: AGPL-3.0-only
//
// S1-S5: the two operation-classified business settings, read, opened by
// capability and written from a real browser against the live API.
//
// **S1-S2 run against any build. S3-S4 need the two reads; S5 needs a revision.**
// `settings.read` and `session.capabilities` are declared on the surface and
// answer on the live API. Against a build without them the screen meets them
// as `unavailable` and falls back: it draws this browser's own last confirmed
// write, and it leaves the controls open and asks once. S1-S2 assert the pair
// and pass on both sides. S3-S4 are about the reads themselves -- a value that
// survives a cleared tab, and controls closed without a refused request -- and
// S5 is about a stale write drawn as a conflict, which needs `settings.read` to
// carry the row's `revision`. Each detects its own precondition, from the
// screen's `data-outcome` and from the read's answer, and records `pending`
// rather than inventing a pass or quietly skipping.
//
// **The seed grants its admin `settings:manage`** (`scripts/local-seed.mjs`,
// since `1148a07`), so ada can write as seeded. The group still issues the
// grant itself through `issueGrant` -- the authority path, the same one
// `n6-revocation.mjs` uses to revoke one -- and takes it back in a `finally`,
// so a row does not pass or fail on what the seed happens to hold that day,
// and the business's grants are left as the group found them.
//
// **The value is put back too.** `four_eyes_threshold` is a shared row, not a
// task this run created, so S1 restores it to what it read before it wrote.
//
// S2 and S4 need no provisioning at all: mia holds nothing on `settings`
// beyond `read`, which is the point of both.
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
  throughClient,
  standaloneStatus,
  users,
} from './harness.mjs';

// S5 is deliberately absent: a required row is one that must pass on this
// build, and S5 cannot until `settings.read` carries a revision.
const REQUIRED = ['S1', 'S2', 'S3', 'S4'];
const SAVE = '[data-settings="save-four-eyes"]';
const KNOWN = '[data-settings="four-eyes-known"]';
const VALUE = '[data-settings="four-eyes-value"]';
const READ = '[data-settings="read"]';
const CAPS = '[data-settings="capabilities"]';
const CONFLICT = '[data-settings="conflict"]';
/** What the screen says the row's key is, in the two places that need it. */
const KEY = 'four_eyes_threshold';

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

/**
 * The group moves from one person to the next.
 *
 * `signIn` goes to `/` and waits for the sign-in form, and a page that already
 * holds a session never draws one -- it routes straight into the application,
 * the wait times out, and every row behind the call is lost with the run. The
 * group signs four people in across five rows on one page, so dropping the
 * session belongs here rather than at each call site.
 */
async function signInAs(page, email) {
  if (!page.url().startsWith(WEB)) await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    sessionStorage.clear();
  });
  await signIn(page, email, 'alpha');
}

/**
 * Wait until the settings read has actually answered.
 *
 * `[data-settings="read"]` is on the page from the first paint, carrying
 * `data-outcome="loading"` while the request is in flight, so waiting for the
 * element -- or for the save button beside it -- says nothing about whether the
 * read has come back. Asserting the screen's provenance in that window reads a
 * page that has not finished opening and calls it incoherent: neither line is
 * drawn yet, because neither is true yet. Every honest outcome is terminal, so
 * "not `loading`" is the whole condition.
 *
 * It is bounded and it does not throw. A read that never answers is a fact
 * about this build that the caller must be free to record in its own words,
 * with the outcome it actually found, rather than one this helper takes the
 * group down with.
 */
async function answered(page, selector) {
  await page
    .waitForFunction(
      (one) => document.querySelector(one)?.getAttribute('data-outcome') !== 'loading',
      selector,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
}

/** The settings read, which is the one the provenance assertion is about. */
const readAnswered = (page) => answered(page, READ);

/**
 * What the screen is showing for the four-eyes threshold, and whether the way
 * it is showing it is coherent.
 *
 * Exactly one of the two lines must be on the page. Both would be two numbers
 * with two provenances, one of them possibly stale; neither would be a screen
 * that has quietly stopped saying anything. `text` is whichever one is there,
 * so a caller can assert the number without caring which build it is on.
 */
async function whatIsShown(page) {
  await readAnswered(page);
  const fromServer = await page.locator(VALUE).count();
  const fromBrowser = await page.locator(KNOWN).count();
  const named = await page.locator('[data-settings="not-readable"]').count();
  const outcome = await page.locator(READ).getAttribute('data-outcome');
  const text =
    fromServer === 1
      ? await page.locator(VALUE).innerText()
      : fromBrowser === 1
        ? await page.locator(KNOWN).innerText()
        : '';
  const coherent = fromServer + fromBrowser === 1 && (fromServer === 1 ? named === 0 : named === 1);
  return {
    ok: coherent,
    text,
    observed:
      `the read answered "${String(outcome)}" and the screen says "${text.trim()}" ` +
      `(server line ${fromServer}, browser line ${fromBrowser}, absent-read notice ${named})`,
  };
}

/** Wait until whichever line the build draws carries this value. */
async function settledOn(page, value) {
  await page
    .waitForFunction(
      ([v, a, b]) =>
        [a, b].some((selector) => document.querySelector(selector)?.textContent?.includes(v)),
      [value, VALUE, KNOWN],
      { timeout: 15_000 },
    )
    .catch(() => undefined);
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

  // **S1 holds on both sides of the reads landing, and that is deliberate.**
  // The screen has two honest openings and which one a person sees is a fact
  // about the API, not about the screen: where `settings.read` answers, the
  // server's own value is drawn and this browser's memory of its last write is
  // not on the page at all; where it does not, the fallback is drawn and the
  // screen names the read that is not answering. Asserting only one of them
  // would make this row fail the day the other becomes true, for a reason that
  // is not a defect. So the row asserts the pair: exactly one of them, never
  // both, never neither.
  const opened = await whatIsShown(page);
  record({
    case: 'S1 the screen opens on the server, or says it could not ask',
    action: 'ada opened /settings',
    observed: opened.observed,
    ok: opened.ok,
    shot: await shot(page, 'S1-settings-opened'),
  });

  await withSettingsGrant(database, alpha, ada, async () => {
    await page.fill('#settings-four-eyes', '1234');
    await page.click(SAVE);
    await settledOn(page, '1234');

    const confirmed = await whatIsShown(page);
    const stored = await storedThreshold(admin, alpha);
    record({
      case: 'S1 an admin sets the threshold and the row holds it',
      action: 'ada set the four-eyes threshold to 1234 with settings:manage in hand',
      observed: `${confirmed.observed}; the row holds ${JSON.stringify(stored)}`,
      ok: confirmed.ok && confirmed.text.includes('1234') && String(stored) === '1234',
      shot: await shot(page, 'S1-threshold-written'),
    });

    // A hard reload: a new document. Where the read answers, the value comes
    // back from the server; where it does not, it stands on the tab's memory of
    // the server's own confirmation. Either way the screen says which.
    await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SAVE, { timeout: 15_000 });
    const after = await whatIsShown(page);
    const stillStored = await storedThreshold(admin, alpha);
    record({
      case: 'S1 it stands across a reload',
      action: 'hard-reloaded /settings',
      observed: `${after.observed}; the row still holds ${JSON.stringify(stillStored)}`,
      ok: after.ok && after.text.includes('1234') && String(stillStored) === '1234',
      shot: await shot(page, 'S1-threshold-after-reload'),
    });

    // Put the shared row back where it was found.
    await page.fill('#settings-four-eyes', String(was));
    await page.click(SAVE);
    await settledOn(page, String(was));
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
  await readCases(page, run, ada, was);
}

/**
 * A member holding nothing on `settings`, and the value that does not move.
 *
 * **There are two ways this build can stop her and the row asserts whichever
 * one is in force.** Where `session.capabilities` answers, the screen knows
 * before she presses and the controls never open, so there is no request to
 * refuse -- that is the whole point of the read, and S4 is the row that says
 * so in its own words. Where the capability read does not answer, she asks
 * once, the server refuses in its own words, and the controls close behind it.
 * What S2 holds across both is the part that matters: she cannot change the
 * value, she is told why, and she is never left pressing a button that will
 * keep being refused.
 */
async function refusedMember(page, admin, alpha) {
  const before = await storedThreshold(admin, alpha);

  await signInAs(page, 'mia@alpha.local');
  await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SAVE, { timeout: 15_000 });

  const sent = [];
  page.on('request', (request) => {
    // `/settings/set_`, not `/settings/`: `settings.read` lives under the same
    // prefix, and counting it here would make the "asked once" assertion count
    // a read as a refused write.
    if (request.url().includes('/settings/set_')) sent.push(request.url());
  });

  const closedOnOpen = await page.locator(SAVE).isDisabled();
  if (closedOnOpen) {
    // The capability read got there first. Press anyway: a closed control that
    // still sends is the defect this row would be blind to otherwise.
    await page.click(SAVE, { force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
  } else {
    await page.fill('#settings-four-eyes', '4321');
    await page.click(SAVE);
    await page
      .waitForSelector('[data-settings="refusal"]', { timeout: 15_000 })
      .catch(() => undefined);
    await page.click(SAVE, { force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const told = await page
    .locator('[data-settings="refusal"], [data-settings="capabilities-because"]')
    .first()
    .innerText()
    .catch(() => '');
  const disabled = await page.locator(SAVE).isDisabled();
  const signOffDisabled = await page.locator('[data-settings="save-sign-off"]').isDisabled();
  const after = await storedThreshold(admin, alpha);
  // One request if she had to ask, none if the read spared her the asking.
  const asked = closedOnOpen ? 0 : 1;

  record({
    case: 'S2 a member cannot change the value, and is told why',
    action: `mia opened /settings and pressed save twice (controls ${closedOnOpen ? 'already closed' : 'open on arrival'})`,
    observed:
      `the screen says "${told.replaceAll('\n', ' ').slice(0, 90)}"; the controls are ` +
      `${disabled && signOffDisabled ? 'closed' : 'still open'}; the row went from ` +
      `${JSON.stringify(before)} to ${JSON.stringify(after)}; ` +
      `${String(sent.length)} write(s) left the browser, ${String(asked)} expected`,
    ok:
      (closedOnOpen ? told.includes('settings:manage') : told.includes('SCOPE_NOT_GRANTED')) &&
      disabled &&
      signOffDisabled &&
      String(before) === String(after) &&
      sent.length === asked,
    shot: await shot(page, 'S2-settings-refused'),
  });
  page.removeAllListeners('request');
}

// ------------------------------------------------- S3-S5: the two reads

/** What the screen says the settings read did. `unavailable` = no such read. */
const readOutcome = (page) => page.locator(READ).getAttribute('data-outcome');

/** The same for the capability read. */
const capsOutcome = (page) => page.locator(CAPS).getAttribute('data-outcome');

/**
 * What the row's revision is, straight from the table.
 *
 * Undefined until lane SETTINGS-REVISION adds the column, which is the same
 * signal the screen feature-detects on: no revision, no `expectedRevision`, no
 * `VERSION_STALE` to draw. The query is written so a table without the column
 * answers `undefined` rather than throwing, because a case that cannot run
 * must record that it did not run, not take the group down with it.
 */
async function storedRevision(admin, businessId) {
  const rows = await admin
    .execute(
      `select revision from public.business_settings
        where business_id = $1 and key = $2`,
      [businessId, KEY],
    )
    .catch(() => []);
  return rows[0]?.revision;
}

/**
 * Whether `settings.read` **carries** a revision for this row, asked through
 * the application's own client with the session on the page.
 *
 * This and not the column is S5's gate. `business_settings` gained `revision`
 * in `0020`, but the screen sends `expectedRevision` only for a row whose read
 * carried one, so a read that does not carry it can never produce a
 * `VERSION_STALE` for S5 to draw -- and moving the row underneath would then
 * lose the person's write silently instead. When the projection starts sending
 * it, this answers true and S5 runs with no edit.
 */
async function readCarriesRevision(page) {
  const { result } = await throughClient(page, {
    read: true,
    name: 'settings.read',
    body: {},
  }).catch(() => ({ result: undefined }));
  const rows = result?.ok === true ? (result.value?.settings ?? result.settings) : undefined;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => row?.key === KEY && row?.revision !== undefined);
}

/** Somebody else writes the row while this person is looking at it. */
async function writtenByAnother(admin, businessId, value) {
  // `to_jsonb($3::numeric)`, not the parameter straight into a `jsonb` column.
  // A bound `'999'` reaches the column as the jsonb **string** `"999"`, which
  // `business_settings_value_matches_type` refuses on a `numeric` row -- the
  // same "a band that arrived as a string is a band no comparison reads" the
  // constraint was written for. The cast makes the other writer's value the
  // number the row says it holds.
  await admin.execute(
    `update public.business_settings
        set value = to_jsonb($3::numeric), revision = revision + 1
      where business_id = $1 and key = $2`,
    [businessId, KEY, String(value)],
  );
}

/** A row nobody can run yet, recorded as exactly that. */
const notYet = (name, action, why) => {
  record({ case: name, action, observed: why, pending: 'its precondition has not landed' });
};

async function readCases(page, run, ada, was) {
  const { database, admin, alpha } = run;

  // S2 left this page signed in as mia, and S3-S5 are ada's.
  await signInAs(page, 'ada@alpha.local');
  await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(READ, { timeout: 15_000 });
  // Both outcomes are sampled once, after both reads have answered. Sampling
  // while either is still `loading` would stand S3-S5 down on this build for a
  // reason that is not true of it: the reads landed, they were simply still in
  // flight when the group looked.
  await readAnswered(page);
  await answered(page, CAPS);
  const reads = await readOutcome(page);
  const caps = await capsOutcome(page);

  await s3(page, { database, admin, alpha, ada, was, reads });
  await s4(page, { admin, alpha, caps });
  await s5(page, { database, admin, alpha, ada, was, reads });
}

/**
 * S3: the value on the screen came from the server, and nothing else could
 * have put it there.
 *
 * The tab's own memory of its last confirmed write is cleared before the
 * reload, so the fallback has nothing to draw. A number on the screen after
 * that is the read's or it is nowhere.
 */
async function s3(page, context) {
  const { database, admin, alpha, ada, was, reads } = context;
  if (reads !== 'ready' && reads !== 'empty') {
    notYet(
      'S3 the value shown comes from the read after a reload',
      "ada reloaded /settings with this tab's memory cleared",
      `the settings read answered "${String(reads)}" — there is no read on this API yet`,
    );
    return;
  }
  await withSettingsGrant(database, alpha, ada, async () => {
    await page.fill('#settings-four-eyes', '1234');
    await page.click(SAVE);
    await page
      .waitForFunction((v) => document.querySelector(v)?.textContent?.includes('1234'), VALUE, {
        timeout: 15_000,
      })
      .catch(() => undefined);

    // The tab forgets. Only the server can answer now.
    await page.evaluate(() => {
      sessionStorage.removeItem(`ops-astro.settings.alpha`);
    });
    await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(VALUE, { timeout: 15_000 });

    const shown = await page.locator(VALUE).innerText();
    const stored = await storedThreshold(admin, alpha);
    const browserSaid = await page.locator(KNOWN).count();
    record({
      case: 'S3 the value shown comes from the read after a reload',
      action: "ada wrote 1234, cleared this tab's memory of it and reloaded /settings",
      observed:
        `the screen says "${shown.trim()}", the row holds ${JSON.stringify(stored)}, and the ` +
        `browser-confirmed line is ${browserSaid === 0 ? 'absent' : 'still drawn'}`,
      ok: shown.includes('1234') && String(stored) === '1234' && browserSaid === 0,
      shot: await shot(page, 'S3-value-from-read'),
    });

    await page.fill('#settings-four-eyes', String(was));
    await page.click(SAVE);
    await page.waitForTimeout(800);
    return undefined;
  });
}

/**
 * S4: a member's controls are closed before anything is asked.
 *
 * The point is the absent request. Before `session.capabilities` the only way
 * to find out that mia may not write was to write and be refused, which is S2.
 * With the read, the screen knows, and the case fails if a request goes out.
 */
async function s4(page, context) {
  const { admin, alpha, caps } = context;
  if (caps !== 'ready' && caps !== 'empty') {
    notYet(
      "S4 a member's controls are closed by capability, with no request",
      'mia opened /settings',
      `the capability read answered "${String(caps)}" — there is no such read on this API yet`,
    );
    return;
  }
  const before = await storedThreshold(admin, alpha);
  const sent = [];
  page.on('request', (request) => {
    if (request.url().includes('/settings/set_')) sent.push(request.url());
  });

  await signInAs(page, 'mia@alpha.local');
  await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SAVE, { timeout: 15_000 });

  const disabled = await page.locator(SAVE).isDisabled();
  const signOff = await page.locator('[data-settings="save-sign-off"]').isDisabled();
  const said = await page
    .locator('[data-settings="capabilities-because"]')
    .innerText()
    .catch(() => '');
  await page.click(SAVE, { force: true }).catch(() => undefined);
  await page.waitForTimeout(500);
  const after = await storedThreshold(admin, alpha);

  record({
    case: "S4 a member's controls are closed by capability, with no request",
    action: 'mia opened /settings and pressed save',
    observed:
      `the controls are ${disabled && signOff ? 'closed' : 'still open'}, the screen says ` +
      `"${said.slice(0, 80)}", ${String(sent.length)} write(s) were sent, and the row went from ` +
      `${JSON.stringify(before)} to ${JSON.stringify(after)}`,
    ok:
      disabled &&
      signOff &&
      said.includes('settings:manage') &&
      sent.length === 0 &&
      String(before) === String(after),
    shot: await shot(page, 'S4-closed-by-capability'),
  });
}

/**
 * S5: somebody else wrote first, and the screen says so instead of losing it.
 *
 * `VERSION_STALE` is drawn with both numbers on the page — what the reread
 * found and what this person asked for — and the overwrite needs a second
 * explicit press. A screen that retried against the fresh revision by itself
 * would turn "somebody else got there first" into "you silently overrode them",
 * which is the failure this whole case exists to make visible.
 */
async function s5(page, context) {
  const { database, admin, alpha, ada, was, reads } = context;
  const column = await storedRevision(admin, alpha);
  const carried = reads === 'ready' ? await readCarriesRevision(page) : false;
  if (reads !== 'ready' || !carried) {
    notYet(
      'S5 a stale write is drawn as a conflict and needs a second press',
      'ada pressed save after another writer moved the row',
      reads !== 'ready'
        ? `the settings read answered "${String(reads)}"`
        : column === undefined
          ? 'business_settings carries no revision column yet'
          : 'business_settings carries a revision, but settings.read does not send it, ' +
            'so the screen has nothing to write an expectedRevision from',
    );
    return;
  }
  await withSettingsGrant(database, alpha, ada, async () => {
    await signInAs(page, 'ada@alpha.local');
    await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(VALUE, { timeout: 15_000 });

    // Ada types against the revision she was shown; somebody else writes.
    await page.fill('#settings-four-eyes', '1200');
    await writtenByAnother(admin, alpha, 999);
    await page.click(SAVE);
    // The block draws on the refusal and fills in "the server holds" only once
    // its reread lands, so its first frame has the refusal and neither number.
    // Wait on the block's own two lines, each holding its value.
    await page
      .waitForFunction(
        ([server, draft]) =>
          document.querySelector(server)?.textContent?.includes('999') === true &&
          document.querySelector(draft)?.textContent?.includes('1200') === true,
        [
          `${CONFLICT} [data-settings="conflict-server"]`,
          `${CONFLICT} [data-settings="conflict-draft"]`,
        ],
        { timeout: 15_000 },
      )
      .catch(() => undefined);

    const drawn = await page
      .locator(CONFLICT)
      .innerText()
      .catch(() => '');
    const held = await storedThreshold(admin, alpha);
    record({
      case: 'S5 a stale write is drawn as a conflict and needs a second press',
      action: 'ada pressed save after another writer moved the row to 999',
      observed:
        `the screen drew "${drawn.replaceAll('\n', ' ').slice(0, 110)}" and the row still ` +
        `holds ${JSON.stringify(held)}`,
      ok: drawn.includes('VERSION_STALE') && drawn.includes('999') && drawn.includes('1200'),
      shot: await shot(page, 'S5-stale-conflict'),
    });

    await page.click('[data-settings="confirm-four-eyes"]');
    await page
      .waitForFunction((v) => document.querySelector(v)?.textContent?.includes('1200'), VALUE, {
        timeout: 15_000,
      })
      .catch(() => undefined);
    const over = await storedThreshold(admin, alpha);
    const gone = await page.locator(CONFLICT).count();
    record({
      case: 'S5 the second press writes over it, against the reread revision',
      action: "ada pressed the conflict's own button",
      observed: `the row holds ${JSON.stringify(over)} and the conflict is ${gone === 0 ? 'gone' : 'still drawn'}`,
      ok: String(over) === '1200' && gone === 0,
      shot: await shot(page, 'S5-written-over'),
    });

    await page.fill('#settings-four-eyes', String(was));
    await page.click(SAVE);
    await page.waitForTimeout(800);
    return undefined;
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
