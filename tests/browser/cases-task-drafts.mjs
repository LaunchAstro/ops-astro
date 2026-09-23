// SPDX-License-Identifier: AGPL-3.0-only
//
// D1: an unsaved title or due date is resolved explicitly, never silently.
//
// A dirty draft is resolved before anything else happens to the record: the Save
// or Discard bar is on the screen, and Refresh, the assignee control and the
// three lifecycle buttons are disabled until one of them is pressed. Nothing is
// merged for the person -- merging is what produced the two overwrite findings
// this replaced.
//
// The resolve bar is shipped behaviour, so its absence is a **failed** required
// case, not a row pending a sibling lane. The four rows below record what the
// screen actually did either way, so a failing run is still diagnosable, but the
// command does not pass without them.
//
// Nothing here is a test-only hook in the product. Every selector it uses is one
// the screen owns.

import { WEB, outcomeOf, record, revisionOn, serverTask, shot, throughClient } from './harness.mjs';

const CHOICE = '[data-draft-resolve="choice"]';
const SAVE = 'button[data-draft-resolve="save"]';
const DISCARD = 'button[data-draft-resolve="discard"]';
const WHY = '[data-draft-resolve="why"]';
const REFRESH = 'button[data-refresh="task"]';
const ASSIGNEE = 'select[aria-label="Assignee"]';
const LIFECYCLE =
  'button[data-lifecycle="start"], button[data-lifecycle="complete"], button[data-lifecycle="reopen"]';
const CONFLICT = '[data-conflict="version"]';
const UNSAVED = '[data-conflict="unsaved"]';
const RELOAD = 'button[data-conflict="reload"]';

const DRAFT_TITLE = 'A title nobody has saved yet';
const SECOND_DUE = '2027-05-06';

/** What the inputs are holding right now. */
const inputs = async (page) => ({
  title: await page.inputValue('#task-title'),
  due: await page.inputValue('#task-due'),
});

/** Every control a dirty draft must hold shut, and whether it is shut. */
async function lockedControls(page) {
  const refresh = await page
    .locator(REFRESH)
    .first()
    .isDisabled()
    .catch(() => undefined);
  const assignee = await page
    .locator(ASSIGNEE)
    .first()
    .isDisabled()
    .catch(() => undefined);
  const lifecycle = await page
    .locator(LIFECYCLE)
    .first()
    .isDisabled()
    .catch(() => undefined);
  return {
    refresh,
    assignee,
    lifecycle,
    all: refresh === true && assignee === true && lifecycle === true,
  };
}

export async function casesTaskDrafts(run) {
  const { page, state } = run;
  const key = state.retryKey ?? state.taskKey;
  await page.goto(`${WEB}/task/${encodeURIComponent(key)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#task-title');
  const saved = await inputs(page);

  await page.fill('#task-title', DRAFT_TITLE);
  const offered = await page
    .waitForSelector(CHOICE, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!offered) {
    await missingBarRows(run, key);
    return;
  }

  await theChoiceBar(run, key);
  await discardIt(run, key, saved);
  await saveIt(run, key);
  await theConflict(run, key);
}

/**
 * No resolve bar on a screen with an unsaved edit. That is the required
 * behaviour missing, so every row fails -- and each one still says what the
 * screen did instead, in the same words a passing run uses, so the two runs are
 * comparable.
 */
async function missingBarRows(run, key) {
  const { page } = run;
  const locked = await lockedControls(page);
  const now = await inputs(page);
  record({
    case: 'D1 a dirty draft is resolved explicitly',
    action: `typed a title on /task/${key} and looked for ${CHOICE}`,
    observed: `no resolve bar on the screen; Refresh disabled=${locked.refresh}, assignee disabled=${locked.assignee}, lifecycle disabled=${locked.lifecycle}; inputs hold ${JSON.stringify(now)} — the unsaved edit is being kept silently instead of resolved`,
    ok: false,
    shot: await shot(page, 'D1-no-resolve-bar'),
  });
  for (const what of ['Discard', 'Save', 'the stale-revision conflict']) {
    record({
      case: `D1 ${what.toLowerCase()} from the resolve bar`,
      action: `press ${what} on /task/${key}`,
      observed: 'the control is not on the screen, so the behaviour cannot be exercised',
      ok: false,
    });
  }
}

async function theChoiceBar(run, key) {
  const { page } = run;
  const locked = await lockedControls(page);
  const why = await page.locator(WHY).count();
  const both =
    (await page.locator(SAVE).count()) === 1 && (await page.locator(DISCARD).count()) === 1;
  record({
    case: 'D1 a dirty draft is resolved explicitly',
    action: `typed a title on /task/${key} without saving`,
    observed: `${CHOICE} is on the screen with Save and Discard (${both}); Refresh disabled=${locked.refresh}, assignee disabled=${locked.assignee}, lifecycle disabled=${locked.lifecycle}; ${why} line(s) saying why`,
    ok: both && locked.all && why > 0,
    shot: await shot(page, 'D1-choice-bar'),
  });
}

async function discardIt(run, key, saved) {
  const { page } = run;
  await page.click(DISCARD);
  await page.waitForSelector(CHOICE, { state: 'detached', timeout: 10_000 }).catch(() => undefined);
  const now = await inputs(page);
  const locked = await lockedControls(page);
  record({
    case: 'D1 discard from the resolve bar',
    action: `pressed Discard on /task/${key}`,
    observed: `inputs hold ${JSON.stringify(now)}; saved was ${JSON.stringify(saved)}; the bar is ${(await page.locator(CHOICE).count()) === 0 ? 'gone' : 'still there'}, Refresh disabled=${locked.refresh}, assignee disabled=${locked.assignee}`,
    ok:
      now.title === saved.title &&
      now.due === saved.due &&
      (await page.locator(CHOICE).count()) === 0 &&
      locked.refresh === false,
    shot: await shot(page, 'D1-discarded'),
  });
}

async function saveIt(run, key) {
  const { page, state } = run;
  const was = await revisionOn(page);
  await page.fill('#task-title', DRAFT_TITLE);
  await page.waitForSelector(CHOICE, { timeout: 10_000 });
  await page.click(SAVE);
  await page
    .waitForFunction(
      (prior) => Number(document.querySelector('[data-revision]')?.dataset.revision) > prior,
      was,
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  await outcomeOf(page);
  const drawn = await page.locator('h2.tpr__title').innerText();
  const task = await serverTask(page, state.retryId ?? state.taskId);
  const updates = (task?.history ?? []).filter((entry) => entry.operation === 'task.update');
  record({
    case: 'D1 save from the resolve bar',
    action: `pressed Save on /task/${key} with an unsaved title`,
    observed: `revision ${was} -> ${await revisionOn(page)}, the header reads "${drawn}", the bar is ${(await page.locator(CHOICE).count()) === 0 ? 'gone' : 'still there'}, ${updates.length} applied task.update in the history`,
    ok:
      drawn === DRAFT_TITLE &&
      (await page.locator(CHOICE).count()) === 0 &&
      updates.length === 1 &&
      task?.title === DRAFT_TITLE,
    shot: await shot(page, 'D1-saved'),
  });
}

/**
 * Two writers. The draft's own base revision is what its save carries, so a
 * second writer who moved the record in between must not be overwritten: the
 * save is refused as stale, the unsaved text is still on the screen to copy,
 * and the other writer's due date survives.
 */
async function theConflict(run, key) {
  const { page, state } = run;
  const recordId = state.retryId ?? state.taskId;
  await page.fill('#task-title', `${DRAFT_TITLE} again`);
  await page.waitForSelector(CHOICE, { timeout: 10_000 });

  const before = await serverTask(page, recordId);
  const second = await throughClient(page, {
    name: 'task.update',
    body: { recordId, fields: { due: SECOND_DUE } },
    options: { expectedRevision: before?.revision },
  });

  await page.click(SAVE);
  const conflict = await page
    .waitForSelector(CONFLICT, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const after = await serverTask(page, recordId);
  record({
    case: 'D1 the stale-revision conflict',
    action: `on /task/${key}, a second writer set due=${SECOND_DUE} through the client, then Save was pressed on the draft taken before it`,
    observed: `the second write ${second.result.ok === true ? `applied at revision ${second.result.value.revision}` : String(second.result.code)}; ${CONFLICT} drawn: ${conflict}, unsaved text kept: ${(await page.locator(UNSAVED).count()) > 0}, reload offered: ${(await page.locator(RELOAD).count()) > 0}; the record's due is now ${JSON.stringify(after?.due ?? null)} and its title ${JSON.stringify(after?.title ?? null)}`,
    ok:
      second.result.ok === true &&
      conflict &&
      (await page.locator(UNSAVED).count()) > 0 &&
      (await page.locator(RELOAD).count()) > 0 &&
      String(after?.due ?? '').startsWith(SECOND_DUE),
    shot: await shot(page, 'D1-version-conflict'),
  });
}
