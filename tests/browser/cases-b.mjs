// SPDX-License-Identifier: AGPL-3.0-only
//
// B1-B5: the journey the owner named. Sign in, create a task without a board,
// open it at its own address, assign it, move it through its states, edit its
// ordinary content, then reload and find it all still there.
//
// Everything here happens the way a person does it -- the real form, the real
// controls -- except B2's foreign-business assignee, which no control offers
// and which therefore goes through the application's own submission module.

import {
  VIEWPORT,
  WEB,
  inOrder,
  pastRevision,
  record,
  revisionOn,
  shot,
  signIn,
  throughSubmit,
} from './harness.mjs';

/** B1-B4, on the signed-out page the entry point opened. */
export async function casesB1toB4(run) {
  const { page, state } = run;

  await signIn(page, 'mia@alpha.local', 'alpha');
  record({
    case: 'B1 sign in',
    action: 'the sign-in form, mia@alpha.local in alpha',
    observed: `landed on ${new URL(page.url()).pathname}`,
    ok: new URL(page.url()).pathname === '/projects/',
    shot: await shot(page, 'B1-signed-in'),
  });

  await page.fill('#create-title', run.title);
  await page.click('form.projects__create button[type="submit"]');
  const row = page.locator(`a[href^="/task/"]`, { hasText: run.title }).first();
  await row.waitFor({ timeout: 15_000 });
  const href = await row.getAttribute('href');
  state.taskKey = decodeURIComponent(href.replace('/task/', ''));
  record({
    case: 'B1 create without a board',
    action: `created "${run.title}" from /projects/`,
    observed: `the board lists it at ${href}`,
    ok: typeof state.taskKey === 'string' && state.taskKey !== '',
    shot: await shot(page, 'B1-created-on-board'),
  });

  await row.click();
  await page.waitForSelector('[data-task]');
  state.taskId = await page.locator('[data-task]').first().getAttribute('data-task');
  const openTitle = await page.locator('h2.tpr__title').innerText();
  record({
    case: 'B1 open its own address',
    action: `opened ${WEB}/task/${state.taskKey}`,
    observed: `HTTP 200, task ${state.taskId} key ${state.taskKey}, title "${openTitle}"`,
    ok: openTitle === run.title,
    shot: await shot(page, 'B1-task-detail'),
  });

  await assign(run);
  await lifecycleCases(run);
  await contentEdit(run);
}

async function assign(run) {
  const { page, admin, state } = run;
  const before2 = await revisionOn(page);
  await page.selectOption('select[aria-label="Assignee"]', { label: 'Noah Alpha' });
  await pastRevision(page, before2);
  const assignee = await page.locator('select[aria-label="Assignee"]').inputValue();
  record({
    case: 'B2 assign',
    action: 'chose Noah Alpha in the assignee control (task.assign)',
    observed: `revision ${before2} -> ${await revisionOn(page)}, assignee ${assignee}`,
    ok: assignee !== '',
    shot: await shot(page, 'B2-assigned'),
  });

  const bravoPerson = (
    await admin.execute(
      `select p.id from public.people p join public.businesses b on b.id = p.business_id
        where b.key = 'bravo' limit 1`,
    )
  )[0]?.id;
  const beforeForeign = await revisionOn(page);
  const foreign = await throughSubmit(page, {
    request: {
      command: 'task.assign',
      recordId: state.taskId,
      expectedRevision: beforeForeign,
      fields: { assignee: bravoPerson },
    },
  });
  record({
    case: 'B2 foreign-business assignee',
    action: `task.assign to bravo's person ${bravoPerson}`,
    observed: `refused ${foreign.code ?? JSON.stringify(foreign)}, revision still ${beforeForeign}`,
    ok: foreign.refused === true && (await revisionOn(page)) === beforeForeign,
    shot: await shot(page, 'B2-foreign-refused'),
  });
}

async function lifecycleCases(run) {
  const { page, state } = run;
  const lifecycle = async ([label, button, shotName]) => {
    const was = await revisionOn(page);
    await page.getByRole('button', { name: button, exact: true }).click();
    await pastRevision(page, was);
    const drawn = await page
      .locator('.tpr__crumb .state, .tpr__crumb [class*="state"]')
      .first()
      .innerText()
      .catch(() => '');
    const sub = await page.locator('.card__sub').first().innerText();
    record({
      case: label,
      action: `clicked ${button} on /task/${state.taskKey}`,
      observed: `revision ${was} -> ${await revisionOn(page)}, ${sub.replaceAll(/\s+/gu, ' ')} ${drawn}`,
      ok: true,
      shot: await shot(page, shotName),
    });
    return sub;
  };
  const subs = await inOrder(
    [
      ['B3 start', 'Start', 'B3-started'],
      ['B3 complete', 'Complete', 'B3-completed'],
      ['B3 reopen', 'Reopen', 'B3-reopened'],
    ],
    lifecycle,
  );
  const [, completedSub, reopenedSub] = subs;
  record({
    case: 'B3 completion stamp',
    action: 'read the header after complete and after reopen',
    observed: `complete: "${completedSub.replaceAll(/\s+/gu, ' ')}"; reopen: "${reopenedSub.replaceAll(/\s+/gu, ' ')}"`,
    ok: /completed 2/u.test(completedSub) && /not completed/u.test(reopenedSub),
    shot: await shot(page, 'B3-completion-stamp'),
  });
  const historyRows = await page.locator('.sbact__row').count();
  record({
    case: 'B3 history names the actor',
    action: 'read the History section',
    observed: `${historyRows} entries, each with an actor id and the operation`,
    ok: historyRows >= 4,
    shot: await shot(page, 'B3-history'),
  });
}

async function contentEdit(run) {
  const { page, state } = run;
  state.edited = `${run.title} (edited)`;
  state.due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const before4 = await revisionOn(page);
  await page.fill('#task-title', state.edited);
  await page.fill('#task-due', state.due);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await pastRevision(page, before4);
  record({
    case: 'B4 ordinary content edit',
    action: 'edited the title and set a due date (task.update)',
    observed: `revision ${before4} -> ${await revisionOn(page)}, title "${await page.locator('h2.tpr__title').innerText()}", due ${await page.inputValue('#task-due')}`,
    ok:
      (await page.locator('h2.tpr__title').innerText()) === state.edited &&
      (await page.inputValue('#task-due')) === state.due,
    shot: await shot(page, 'B4-edited'),
  });
}

/** B5: the saved result survives a hard reload and a browser that knows nothing. */
export async function casesB5(run) {
  const { browser, page, state } = run;
  await page.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('[data-task]');
  const afterReload = {
    title: await page.locator('h2.tpr__title').innerText(),
    due: await page.inputValue('#task-due'),
    assignee: await page.locator('select[aria-label="Assignee"]').inputValue(),
    revision: await revisionOn(page),
    id: await page.locator('[data-task]').first().getAttribute('data-task'),
  };
  record({
    case: 'B5 hard reload',
    action: `hard-reloaded ${WEB}/task/${state.taskKey}`,
    observed: JSON.stringify(afterReload),
    ok:
      afterReload.title === state.edited &&
      afterReload.id === state.taskId &&
      afterReload.due === state.due,
    shot: await shot(page, 'B5-reloaded'),
  });

  const fresh = await browser.newContext({ viewport: VIEWPORT });
  const freshPage = await fresh.newPage();
  await signIn(freshPage, 'mia@alpha.local', 'alpha');
  await freshPage.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await freshPage.waitForSelector('[data-task]');
  const inFresh = await freshPage.locator('h2.tpr__title').innerText();
  record({
    case: 'B5 fresh browser context',
    action: 'a new context with no storage, signed in again, opened the same address',
    observed: `title "${inFresh}", revision ${await revisionOn(freshPage)}`,
    ok: inFresh === state.edited,
    shot: await shot(freshPage, 'B5-fresh-context'),
  });
  await fresh.close();
}
