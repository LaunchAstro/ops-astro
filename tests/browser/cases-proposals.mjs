// SPDX-License-Identifier: AGPL-3.0-only
//
// P1-P3: what a proposal actually stored, the exact version an approval binds
// itself to, and what the server says when a decision names a version that has
// moved on.
//
// **This group creates the task it proposes on.** The title carries the run's
// own timestamp, so a lineage already in the database cannot make a case pass,
// and nothing here reaches a task another case owns.
//
// **P2 and P3 issue their own `decide` grant.** `task.propose` takes `write`
// and `task.decide` takes the `decide` action on the `task` collection
// (`commands/surface.ts` declares it). When this file was written no seeded
// role held `decide`; `scripts/local-seed.mjs` now grants it to the admin. The
// cases still issue the grant themselves through `issueGrant` -- the authority
// path, the same one `n6-revocation.mjs` uses to revoke one -- and take it back
// in a `finally`, so they do not depend on the seed and leave the business's
// grants as they found them.
//
// **P1 fills the form, and the first draft of this file could not.** The form
// was sending `step` as a bare string where the command's contract is
// `step: { kind, payload }` (`commands/requests.ts`), and `propose.ts` puts
// `step.kind` straight into `planned_steps.kind`, which is `not null`
// (`migrations/0010_*.sql`); the handler therefore threw and the caller was
// answered 503 `SERVICE_UNAVAILABLE` by `apps/api/server.ts`. That is recorded
// here because it is the reason this case asserts the shape of what was stored
// rather than only that a version appeared: a proposal the screen believes it
// made and the server never wrote is exactly the failure a person cannot see.
//
// **The purpose is a slug, not a sentence.** `proposal_versions` checks it
// against `^[a-z][a-z0-9_]{0,62}$`, the same shape `delegations.purpose`
// carries, because a pickup mints a delegation on this exact purpose. So the
// purpose typed into the form here is `client_renewal_quote`: a dotted
// `client.renewal.quote` violates that check, and a violated check arrives as
// the same 503 rather than as anything a person could act on.
//
// **The ids are the projection's, never this file's.** What the screen drew is
// compared against what `task.read` answers, and the version, lineage and gate
// the later cases work on are taken from that answer. A test that remembered
// the id it had typed into a form would be comparing the browser with itself.
//
// P2 is the exact-version property, which is the whole reason the projection
// rides on the task detail. The `versionId` on the Approve button is read from
// the page and compared against the `versionId` of the version container whose
// evidence pack is on the screen: what is decided has to be what was displayed.
// Then the approval is pressed and the reservation it created is read back from
// the page, because money set aside is the server's answer to an approval and
// not this screen's guess at one.
//
// P3 makes a version stale honestly: a second version is proposed into the same
// lineage, which is `propose.ts` marking the previous version superseded and its
// pending gate with it. The screen cannot do that on its own -- its form sends
// no `lineageId`, and `propose` opens a *new* lineage when none is named -- so
// the second version goes in through the client with the lineage the first one
// opened. The refusal then has two halves, and they are two rows because they
// are two different facts. `VERSION_SUPERSEDED` needs a live gate named beside a
// version that is not the one it is bound to, and that is a body the screen
// never builds; it is built here through the client. What the screen can reach
// on its own is the other half: a page holding a version that has since been
// superseded, whose Approve button names the gate that went superseded with it,
// which the server answers `GATE_ALREADY_DECIDED`. Both are the server telling
// this page it is no longer describing the record, and the page answers the only
// way it honestly can -- it quotes the code and reads the task again.
//
// Run: node tests/browser/cases-proposals.mjs  (or through slice-acceptance)

import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  VIEWPORT,
  WEB,
  closeQuietly,
  fromEnvFile,
  outcomeOf,
  record,
  revisionOn,
  serverTask,
  shot,
  signIn,
  standaloneStatus,
  throughClient,
  users,
} from './harness.mjs';

/** The rows a standalone run has to have passed before it may exit zero. */
const REQUIRED = ['P1', 'P2', 'P3'];

/** The slug shape `proposal_versions` and `delegations` both check against. */
const PURPOSE = 'client_renewal_quote';
/** What the form calls 250.00 and the wire calls minor units. */
const CEILING_MINOR = 25_000;
const CEILING_DRAWN = 'AUD 250.00';

const APPROVE = '[data-decide="approve"]';
const REFUSAL = '[data-decide="refusal"]';

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

/** `task:decide` for as long as the case needs it, then taken back. */
async function withDecideGrant(database, businessId, person, work) {
  const id = await database.withBusiness(businessId, async (tx) => {
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: person.person_id },
      scope: { kind: 'business', id: null },
      collection: 'task',
      action: 'decide',
      parentGrantId: null,
      grantedByActorId: person.actor_id,
    });
    if (!issued.ok) throw new Error(`decide grant refused ${issued.refusal.code}`);
    return issued.value;
  });
  try {
    return await work(id);
  } finally {
    await database.withBusiness(businessId, async (tx) => revokeGrant(tx, id));
  }
}

/** The task this group makes for itself, so it never proposes on anyone else's. */
async function createTask(page, title) {
  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#create-title', { timeout: 15_000 });
  await page.fill('#create-title', title);
  await page.click('form.projects__create button[type="submit"]');
  const row = page.locator('a[href^="/task/"]', { hasText: title }).first();
  await row.waitFor({ timeout: 15_000 });
  const href = await row.getAttribute('href');
  await row.click();
  await page.waitForSelector('[data-task]', { timeout: 15_000 });
  return { href, key: decodeURIComponent(href.replace('/task/', '')) };
}

/**
 * A proposal, through the client the screens use.
 *
 * `lineageId` is given to continue a lineage and left out to open one, which is
 * the only difference between P1's first version and P3's superseding one.
 */
async function proposeThrough(page, ask) {
  const { result } = await throughClient(page, {
    name: 'task.propose',
    body: {
      recordId: ask.recordId,
      purpose: PURPOSE,
      maximumMinor: CEILING_MINOR,
      currency: 'AUD',
      payload: { step: PURPOSE },
      step: { kind: PURPOSE, payload: { step: PURPOSE } },
      ...(ask.lineageId === undefined ? {} : { lineageId: ask.lineageId }),
    },
    options: { expectedRevision: ask.revision },
  });
  if (result.ok !== true) {
    throw new Error(`task.propose answered ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result.value.detail;
}

/**
 * What the screen is drawing for the version whose evidence is on it.
 *
 * The container is found *from the evidence pack outwards*, because the property
 * P2 is about is that the decision belongs to the version a person read. Walking
 * down from the lineage instead would be this file deciding which version was
 * displayed, which is the very thing under test.
 */
async function drawnVersion(page) {
  return await page.evaluate(() => {
    const body = document.querySelector('[data-evidence="body"]');
    const container = body === null ? null : body.closest('[data-version-id]');
    const gate = container?.querySelector('[data-gate-state]') ?? null;
    return {
      lineages: document.querySelectorAll('[data-lineage-id]').length,
      lineageState: document.querySelector('[data-lineage-id]')?.dataset.lineageState ?? null,
      versionId: container?.dataset.versionId ?? null,
      version: container?.dataset.version ?? null,
      superseded: container?.dataset.versionSuperseded ?? null,
      text: container?.textContent ?? '',
      digest: container?.querySelector('[data-version="digest"]')?.textContent ?? '',
      renderer: container?.querySelector('[data-evidence="renderer"]')?.textContent ?? '',
      evidenceDigest: container?.querySelector('[data-evidence="digest"]')?.textContent ?? '',
      evidenceBody: body?.textContent ?? '',
      gateState: gate?.dataset.gateState ?? null,
      gateExpired: gate?.dataset.gateExpired ?? null,
      supersededIds: [...document.querySelectorAll('[data-version-superseded="true"]')].map(
        (node) => node.dataset.versionId,
      ),
    };
  });
}

/** Open the task's own address as a new document: a fresh read, nothing carried. */
async function openTask(page, href) {
  await page.goto(`${WEB}${href}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]', { timeout: 15_000 });
  await outcomeOf(page);
}

export async function casesProposals(run) {
  // Its own context, as every group in this checklist has: a shared page would
  // carry one group's session and one group's session storage into another's.
  const context = await run.browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await proposals(page, run);
  } finally {
    await context.close();
  }
}

async function proposals(page, run) {
  const { database, admin, alpha } = run;
  const ada = await personOf(admin, alpha, 'ada@alpha.local');

  await signIn(page, 'ada@alpha.local', 'alpha');
  const task = await createTask(page, `Proposals ${run.stamp}`);
  run.state.proposalTaskKey = task.key;
  const recordId = await page.locator('[data-task]').first().getAttribute('data-task');

  const first = await proposed(page, task, recordId);
  await withDecideGrant(database, alpha, ada, async () => approved(page, first));
  await withDecideGrant(database, alpha, ada, async () => stale(page, task, recordId, first));
}

/** P1: a proposal is stored through the form, and the screen draws what was stored. */
async function proposed(page, task, recordId) {
  // The form, as a person fills it: dollars in the field, minor units on the
  // wire, and the purpose typed as the slug the database's own check requires.
  await page.fill('#propose-purpose', PURPOSE);
  await page.fill('#propose-maximum', '250.00');
  await page.selectOption('#propose-currency', 'AUD');
  await page.click('[data-propose="submit"]');
  await page
    .waitForSelector('[data-lineage-id] [data-evidence="body"]', { timeout: 15_000 })
    .catch(() => undefined);
  const refused = await page
    .locator('[data-propose="refusal"]')
    .innerText()
    .catch(() => '');
  const drawn = await drawnVersion(page);
  // Nothing in this file names the version: the ids come from the projection,
  // because the form's answer is the server's and the page is what drew it.
  const lineage = (await serverTask(page, recordId))?.proposals?.[0];
  const detail = lineage?.versions?.[0] ?? {};

  record({
    case: 'P1 a proposal is drawn with its ceiling, its digest and its evidence',
    action: `ada filled the form on ${task.key}: ${PURPOSE}, up to ${CEILING_DRAWN}`,
    observed:
      `${String(drawn.lineages)} ${drawn.lineageState ?? 'no'} lineage, version ` +
      `${String(drawn.version)} carrying "${drawn.digest.trim()}", ` +
      `"${drawn.renderer.trim()}"${drawn.evidenceDigest.trim()}, ` +
      `${String(drawn.evidenceBody.length)} characters of evidence, gate ` +
      `${String(drawn.gateState)} and expired=${String(drawn.gateExpired)}` +
      `${refused === '' ? '; the form quoted no refusal' : `; the form quoted "${refused}"`}`,
    ok:
      refused === '' &&
      drawn.lineages === 1 &&
      drawn.lineageState === 'live' &&
      drawn.versionId === detail.versionId &&
      drawn.version === '1' &&
      drawn.text.includes(PURPOSE) &&
      drawn.text.includes(CEILING_DRAWN) &&
      drawn.digest.includes(detail.payloadDigest) &&
      drawn.renderer.trim().length > 'rendered by '.length &&
      /[0-9a-f]{64}/u.test(drawn.evidenceDigest) &&
      drawn.evidenceBody.length > 0 &&
      drawn.gateState === 'pending' &&
      drawn.gateExpired === 'false',
    shot: await shot(page, 'P1-proposal-drawn'),
  });

  // A hard reload is a new document and a new `task.read`: nothing the form's
  // own answer left in the tab can reach it. The projection is then read through
  // the app's client and compared field by field with what the page draws, so
  // "it was stored" is the server's answer rather than this tab's memory of what
  // it sent.
  await openTask(page, task.href);
  const again = await drawnVersion(page);
  const version = (await serverTask(page, recordId))?.proposals?.[0]?.versions?.[0];
  record({
    case: 'P1 the values on the screen are the server’s own',
    action: `hard-reloaded ${task.href} and read the projection back`,
    observed:
      `the page still draws version ${String(again.version)} ${String(again.versionId)}; the ` +
      `projection answers purpose ${String(version?.purpose)}, ceiling ` +
      `${String(version?.maximumMinor)} ${String(version?.currency)}, digest ` +
      `${String(version?.payloadDigest).slice(0, 12)}…, evidence digest ` +
      `${String(version?.evidence?.digest).slice(0, 12)}…`,
    ok:
      again.versionId === detail.versionId &&
      again.digest.includes(detail.payloadDigest) &&
      again.evidenceBody.length > 0 &&
      version?.versionId === detail.versionId &&
      version.purpose === PURPOSE &&
      version.maximumMinor === CEILING_MINOR &&
      version.currency === 'AUD' &&
      version.payloadDigest === detail.payloadDigest &&
      again.evidenceDigest.includes(String(version.evidence?.digest)),
    shot: await shot(page, 'P1-proposal-after-reload'),
  });

  return {
    lineageId: lineage?.lineageId,
    versionId: detail.versionId,
    version: detail.version,
    gateId: detail.gate?.id,
    payloadDigest: detail.payloadDigest,
    href: task.href,
    key: task.key,
    recordId,
  };
}

/** P2: the button decides the version that was displayed, and money is held. */
async function approved(page, first) {
  await openTask(page, first.href);
  const drawn = await drawnVersion(page);
  const approve = page.locator(APPROVE);
  const onButton = await approve.getAttribute('data-version-id');
  const gateOnButton = await approve.getAttribute('data-gate-id');

  record({
    case: 'P2 the decision names the version whose evidence is on the screen',
    action: 'read the version and gate the Approve button carries',
    observed:
      `the button names version ${String(onButton)} on gate ${String(gateOnButton)}, and the ` +
      `evidence on the screen belongs to version ${String(drawn.versionId)}`,
    ok:
      onButton === drawn.versionId &&
      onButton === first.versionId &&
      gateOnButton === first.gateId &&
      (await approve.count()) === 1,
  });

  await approve.click();
  await page.waitForSelector('[data-reservation-id]', { timeout: 15_000 }).catch(() => undefined);
  const reservation = page.locator('[data-reservation-id]').first();
  const state = await reservation.getAttribute('data-reservation-state').catch(() => null);
  const attempt = await page
    .locator('[data-attempt-state]')
    .first()
    .getAttribute('data-attempt-state')
    .catch(() => null);
  const quoted = await page
    .locator(REFUSAL)
    .innerText()
    .catch(() => '');
  const closed = await page.locator('[data-decide="closed"]').count();

  record({
    case: 'P2 the approval holds the money and the gate is not decided twice',
    action: 'ada pressed Approve with task:decide in hand',
    observed:
      `the reservation is "${String(state)}" with attempt "${String(attempt)}"; the screen ` +
      `${quoted === '' ? 'quoted no refusal' : `quoted "${quoted.slice(0, 80)}"`} and ` +
      `${closed === 1 ? 'no longer offers a decision' : 'still offers one'}`,
    ok: state === 'held' && attempt !== null && quoted === '' && closed === 1,
    shot: await shot(page, 'P2-approved-reservation-held'),
  });
}

/** P3: a decision on a version that has moved is refused, and the page rereads. */
async function stale(page, task, recordId, first) {
  // The honest way to make a version stale: another version in the same
  // lineage. `propose.ts` marks the previous one superseded and its pending
  // gate with it, so the staleness is the server's own rather than arranged.
  await openTask(page, task.href);
  const second = await proposeThrough(page, {
    recordId,
    revision: await revisionOn(page),
    lineageId: first.lineageId,
  });
  await openTask(page, task.href);
  const drawn = await drawnVersion(page);

  const { result } = await throughClient(page, {
    name: 'task.decide',
    body: {
      gateId: second.gateId,
      versionId: first.versionId,
      decision: 'approve',
      note: 'Deciding a version this gate is not bound to, on purpose.',
    },
  });

  record({
    case: 'P3 a live gate named with a stale version is refused VERSION_SUPERSEDED',
    action:
      `proposed version ${String(second.version)} into lineage ${first.lineageId.slice(0, 8)}… ` +
      'through the app’s own client, because the form names no lineage and so can ' +
      'only open a new one, then decided the new gate while naming the version it superseded',
    observed:
      `the screen draws version ${String(drawn.version)} as the live one and ` +
      `${String(drawn.supersededIds.length)} superseded version(s); the server answered ` +
      `${String(result.refused === true ? result.code : JSON.stringify(result).slice(0, 120))}`,
    ok:
      result.refused === true &&
      result.code === 'VERSION_SUPERSEDED' &&
      drawn.versionId === second.versionId &&
      drawn.supersededIds.includes(first.versionId) &&
      drawn.gateState === 'pending',
  });

  await screenRereads(page, recordId, second);
}

/**
 * The screen's own path to the same refusal.
 *
 * A third version is proposed while the page is left holding the second, so the
 * Approve button on the screen now names a gate the server has marked
 * superseded. That is the stale press a person can actually make from this
 * screen, and the code it earns is `GATE_ALREADY_DECIDED`: the gate is checked
 * before the version it carries, and the screen can only ever name the gate of
 * the version it drew. What is proven here is the page's answer to a refusal --
 * it quotes the server's own words and reads the task again rather than retrying
 * a decision the server has already declined.
 */
async function screenRereads(page, recordId, second) {
  const before = await drawnVersion(page);
  await proposeThrough(page, {
    recordId,
    revision: await revisionOn(page),
    lineageId: second.lineageId,
  });

  const reads = [];
  page.on('request', (request) => {
    if (request.url().includes('/task/read')) reads.push(request.url());
  });

  await page.locator(APPROVE).click();
  await page.waitForSelector(REFUSAL, { timeout: 15_000 }).catch(() => undefined);
  const quoted = await page
    .locator(REFUSAL)
    .innerText()
    .catch(() => '');
  await page
    .waitForFunction(
      (had) => document.querySelector('[data-version-id]')?.dataset.versionId !== had,
      before.versionId,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  const after = await drawnVersion(page);

  record({
    case: 'P3 the screen quotes the refusal and reads the task again',
    action: 'pressed Approve on a page whose version had been superseded underneath it',
    observed:
      `the screen quoted "${quoted.slice(0, 90)}", made ${String(reads.length)} fresh ` +
      `task.read request(s), and moved from version ${String(before.version)} to ` +
      `${String(after.version)}`,
    ok:
      quoted.includes('GATE_ALREADY_DECIDED') &&
      reads.length > 0 &&
      after.versionId !== before.versionId &&
      after.version === '3',
    shot: await shot(page, 'P3-stale-version-refused'),
  });
}

// ------------------------------------------------------------------ standalone

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'proposals-cases' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'proposals-cases' });
  const rows = await admin.execute('select id from public.businesses where key = $1', ['alpha']);
  const run = {
    browser,
    database,
    admin,
    alpha: rows[0]?.id,
    stamp: new Date().toISOString(),
    state: {},
  };
  try {
    await casesProposals(run);
  } catch (error) {
    record({
      case: 'P run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
    await closeQuietly(database);
    await closeQuietly(admin);
  }
  console.log(`task created by this run: ${String(run.state.proposalTaskKey)}`);
  process.exitCode = standaloneStatus('proposals', REQUIRED);
}
