// SPDX-License-Identifier: AGPL-3.0-only
//
// D1: unsaved title and due date across the other things a person does on the
// task page, in the real browser.
//
// **This case is written against the behaviour DRAFT-FIX is landing, not the
// behaviour at this head.** Review finding 2 was that a successful assign or
// lifecycle action started a read, `RecordState` unmounted the form while it
// was in flight, and whatever the person had typed died with it. The first fix
// held the drafts across the refresh instead, and the delta review of
// `ac90768` then held two P2 findings against *that*: a draft saved with the
// freshly read revision can overwrite another writer, and a late successful
// save clears newer typing. So silently keeping the drafts is not the target
// either.
//
// The target is explicit: with a dirty title or due date, assign, the state
// actions and Refresh either offer a Save-or-Discard choice or are disabled
// until one is made. Never silent loss, and never silent survival. Each probe
// below classifies what actually happened into one of those three, passes only
// on the explicit one, and records `pending DRAFT-FIX` when the screen still
// resolves the draft silently either way.
//
// The one thing that does not change is authority: a draft must not outlive
// the grant behind it. A draft still on the screen after its grant is gone
// would be stale authorised data, which is worse than losing it. So the grant
// is revoked through the authority path with the drafts in the inputs, the
// same Refresh is pressed, and the screen must go to `denied`.
//
// Nothing here is a test-only hook in the product. Every control it touches is
// one a person uses.

import { WEB, outcomeOf, record, revisionOn, shot, users } from './harness.mjs';
import { personOfLogin, revokeTaskRead } from './n6-revocation.mjs';
import { restoreTaskRead } from './cases-n6-n7.mjs';

const DRAFT_TITLE = 'A title nobody has saved yet';
const DRAFT_DUE = '2027-03-04';

/** The controls a dirty draft must not be lost to. */
const ASSIGNEE = 'select[aria-label="Assignee"]';
const REFRESH = '[data-refresh="task"]';

/** What the inputs are holding right now. */
const inputs = async (page) => ({
  title: await page.inputValue('#task-title'),
  due: await page.inputValue('#task-due'),
});

const held = (now) => now.title === DRAFT_TITLE && now.due === DRAFT_DUE;

/**
 * An explicit choice on the screen: a Discard control, or anything the screen
 * marks as the draft's own decision. `Save changes` is always there, so it is
 * not on its own a sign that the screen asked.
 */
async function choiceOffered(page) {
  const marked = await page.locator('[data-draft], [data-draft-choice]').count();
  const discard = await page.getByRole('button', { name: /discard/iu }).count();
  return { marked, discard, offered: marked > 0 || discard > 0 };
}

/** Put the drafts back in the inputs, whatever the last probe did to them. */
async function makeDirty(page) {
  await page.fill('#task-title', DRAFT_TITLE);
  await page.fill('#task-due', DRAFT_DUE);
}

/**
 * One probe: with both fields dirty, reach for `control` and say which of the
 * three things happened.
 *
 * `act` returns what it observed; it is not expected to succeed, because a
 * screen that refuses the action while dirty is the target behaviour.
 */
async function probe(page, given) {
  await makeDirty(page);
  const before = await choiceOffered(page);
  const disabledWhileDirty = given.control
    ? await page.locator(given.control).first().isDisabled()
    : false;
  const acted = await given.act();
  const after = await choiceOffered(page);
  const now = await inputs(page);

  const explicit = disabledWhileDirty || (after.offered && !before.offered) || after.offered;
  const lost = !explicit && !held(now);
  const survived = !explicit && held(now);
  return {
    acted,
    now,
    disabledWhileDirty,
    choice: after,
    verdict: explicit
      ? 'explicit'
      : lost
        ? 'silent-loss'
        : survived
          ? 'silent-survival'
          : 'unclear',
  };
}

function recordProbe(given) {
  const { verdict } = given.result;
  record({
    case: given.case,
    action: given.action,
    observed: `${given.result.acted}; the screen ${given.result.disabledWhileDirty ? 'disabled the control while dirty' : given.result.choice.offered ? 'offered an explicit draft choice' : 'offered no draft choice'}, inputs hold ${JSON.stringify(given.result.now)} — ${verdict}`,
    ok: verdict === 'explicit' ? true : verdict === 'silent-loss' ? false : undefined,
    pending: verdict === 'silent-survival' ? 'DRAFT-FIX' : undefined,
    shot: given.shot,
  });
}

export async function casesTaskDrafts(run) {
  const { page, state } = run;
  const key = state.retryKey ?? state.taskKey;
  await page.goto(`${WEB}/task/${encodeURIComponent(key)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#task-title');
  const saved = await inputs(page);

  await makeDirty(page);
  record({
    case: 'D1 drafts typed, nothing saved',
    action: `typed a title and a due date on /task/${key} and did not press Save changes`,
    observed: `inputs hold ${JSON.stringify(await inputs(page))}; the header still reads "${await page.locator('h2.tpr__title').innerText()}"`,
    ok:
      held(await inputs(page)) && (await page.locator('h2.tpr__title').innerText()) !== DRAFT_TITLE,
    shot: await shot(page, 'D1-drafts-typed'),
  });

  await dirtyAssign(run, key);
  await dirtyStateAction(run, key);
  await dirtyRefresh(run, key);
  await afterDeniedRead(run, key, saved);
}

async function dirtyAssign(run, key) {
  const { page } = run;
  const result = await probe(page, {
    control: ASSIGNEE,
    act: async () => {
      const was = await revisionOn(page);
      const chosen = await page
        .selectOption(ASSIGNEE, { label: 'Noah Alpha' })
        .then(() => 'the assignee control accepted a choice')
        .catch((error) => `the assignee control refused the choice: ${String(error).slice(0, 60)}`);
      await settleRead(page);
      return `${chosen}; revision ${was} -> ${await revisionOn(page)}`;
    },
  });
  recordProbe({
    case: 'D1 assign with a dirty draft',
    action: `chose Noah Alpha on /task/${key} with an unsaved title and due date`,
    result,
    shot: await shot(page, 'D1-dirty-assign'),
  });
}

async function dirtyStateAction(run, key) {
  const { page } = run;
  const name = (await page.getByRole('button', { name: 'Start', exact: true }).count())
    ? 'Start'
    : 'Reopen';
  const button = page.getByRole('button', { name, exact: true });
  const result = await probe(page, {
    act: async () => {
      const was = await revisionOn(page);
      const disabled = await button.isDisabled();
      if (disabled) return `${name} is disabled while the draft is dirty`;
      await button.click();
      await settleRead(page);
      return `clicked ${name}; revision ${was} -> ${await revisionOn(page)}`;
    },
  });
  recordProbe({
    case: 'D1 a state action with a dirty draft',
    action: `clicked ${name} on /task/${key} with an unsaved title and due date`,
    result,
    shot: await shot(page, 'D1-dirty-state-action'),
  });
}

async function dirtyRefresh(run, key) {
  const { page } = run;
  const result = await probe(page, {
    control: REFRESH,
    act: async () => {
      if (await page.locator(REFRESH).first().isDisabled())
        return 'Refresh is disabled while the draft is dirty';
      await page.click(REFRESH);
      return `pressed Refresh; the read settled on data-outcome="${await settleRead(page)}"`;
    },
  });
  recordProbe({
    case: 'D1 Refresh with a dirty draft',
    action: `pressed Refresh on /task/${key}, an authorised reread of the same task, with an unsaved title and due date`,
    result,
    shot: await shot(page, 'D1-dirty-refresh'),
  });
}

/** Wait for whatever read the last action started, and say where it landed. */
async function settleRead(page) {
  const outcome = await outcomeOf(page);
  if (outcome === 'ready')
    await page.waitForSelector('#task-title', { timeout: 15_000 }).catch(() => undefined);
  return outcome;
}

async function afterDeniedRead(run, key, saved) {
  const { page, database, admin, alpha } = run;
  const login = users.find((user) => user.email === 'mia@alpha.local');
  const personId = await personOfLogin(admin, alpha, login.provider, login.subject);
  if (personId === undefined) {
    record({
      case: 'D1 a denied read clears the drafts',
      action: 'derive the person behind mia@alpha.local through logins/person_logins',
      observed: 'the login could not be walked to a person, so the grant was never touched',
      ok: undefined,
    });
    return;
  }

  await makeDirty(page).catch(() => undefined);
  const revoked = await revokeTaskRead(database, alpha, personId);
  await page.click(REFRESH).catch(() => undefined);
  const deniedOutcome = await settleRead(page);
  const stillDrawn = await page.locator('#task-title').count();
  record({
    case: 'D1 a denied read clears the drafts',
    action: `revoked ${revoked.length} live task:read grant(s) through revokeGrant on /task/${key}, then pressed the same Refresh`,
    observed: `data-outcome="${deniedOutcome}", ${stillDrawn} draft input(s) left on the screen`,
    ok: deniedOutcome === 'denied' && stillDrawn === 0,
    shot: await shot(page, 'D1-denied-clears-drafts'),
  });

  await restoreTaskRead(database, alpha, personId);
  await page.click(REFRESH).catch(() => undefined);
  const backOutcome = await settleRead(page);
  const now = await inputs(page).catch(() => ({ title: undefined, due: undefined }));
  record({
    case: 'D1 the grant comes back to saved values, not the drafts',
    action: 'reissued the task:read grant and pressed Refresh again',
    observed: `data-outcome="${backOutcome}", inputs hold ${JSON.stringify(now)}; saved was ${JSON.stringify(saved)}`,
    ok: backOutcome === 'ready' && now.title === saved.title && !held(now),
    shot: await shot(page, 'D1-restored-shows-saved'),
  });
}
