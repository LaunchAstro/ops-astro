// SPDX-License-Identifier: AGPL-3.0-only
//
// N1-N2: who cannot see the task, and what the screen says instead.
//
// N1 is another business: a real foreign task and a fabricated key must look
// the same, or the difference between them is an existence oracle. N2 is this
// business: a member with no grant, and a verified login with no membership.
// Both must read `denied` and not `empty` -- "there is nothing here" and "you
// may not see what is here" are different sentences and the screen must not
// swap one for the other.

import { VIEWPORT, WEB, outcomeOf, record, shot, signIn } from './harness.mjs';

export async function casesN1toN2(run) {
  await foreignBusiness(run);
  await noGrantAndNoMembership(run);
}

async function foreignBusiness(run) {
  const { browser, state } = run;
  const bravo = await browser.newContext({ viewport: VIEWPORT });
  const bravoPage = await bravo.newPage();
  await signIn(bravoPage, 'bea@bravo.local', 'bravo');
  await bravoPage.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  const foreignOutcome = await outcomeOf(bravoPage);
  record({
    case: "N1 B opens A's task",
    action: `bea, signed into bravo, opened /task/${state.taskKey}`,
    observed: `the page draws data-outcome="${foreignOutcome}" and no task fields`,
    ok: foreignOutcome !== 'ready',
    shot: await shot(bravoPage, 'N1-foreign-task'),
  });

  await bravoPage.goto(`${WEB}/task/${encodeURIComponent('T-000000')}`, {
    waitUntil: 'domcontentloaded',
  });
  const fabricatedOutcome = await outcomeOf(bravoPage);
  record({
    case: 'N1 B opens a fabricated id',
    action: 'bea opened /task/T-000000',
    observed: `data-outcome="${fabricatedOutcome}", indistinguishable from the real foreign task`,
    ok: fabricatedOutcome === foreignOutcome,
    shot: await shot(bravoPage, 'N1-fabricated-id'),
  });

  await bravoPage.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await bravoPage.waitForSelector('[data-outcome]');
  const bravoBoard = await outcomeOf(bravoPage);
  record({
    case: 'N1 positive control in B',
    action: "bea reads bravo's own board",
    observed: `data-outcome="${bravoBoard}" (bravo has no tasks, and empty is not denied)`,
    ok: bravoBoard === 'empty' || bravoBoard === 'ready',
    shot: await shot(bravoPage, 'N1-positive-control'),
  });
  await bravo.close();
}

async function noGrantAndNoMembership(run) {
  const { browser, state } = run;
  const noahContext = await browser.newContext({ viewport: VIEWPORT });
  const noahPage = await noahContext.newPage();
  await signIn(noahPage, 'noah@alpha.local', 'alpha');
  await noahPage.waitForSelector('[data-outcome]');
  const noahBoard = await outcomeOf(noahPage);
  const noahText = await noahPage.locator('[data-outcome]').first().innerText();
  record({
    case: 'N2 member with no grant',
    action: 'noah@alpha.local, a member of alpha with no task scope, opened /projects/',
    observed: `data-outcome="${noahBoard}", text quotes ${JSON.stringify(noahText.replaceAll(/\s+/gu, ' ').slice(0, 90))}`,
    ok: noahBoard === 'denied',
    shot: await shot(noahPage, 'N2-board-denied'),
  });
  await noahPage.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  const noahTask = await outcomeOf(noahPage);
  record({
    case: 'N2 detail is denied, not empty',
    action: `noah opened /task/${state.taskKey}`,
    observed: `data-outcome="${noahTask}"`,
    ok: noahTask === 'denied',
    shot: await shot(noahPage, 'N2-task-denied'),
  });
  await noahContext.close();

  const orphanContext = await browser.newContext({ viewport: VIEWPORT });
  const orphanPage = await orphanContext.newPage();
  await signIn(orphanPage, 'orphan@alpha.local', 'alpha');
  await orphanPage.waitForSelector('[data-outcome]');
  const orphanOutcome = await outcomeOf(orphanPage);
  const orphanText = await orphanPage.locator('[data-outcome]').first().innerText();
  record({
    case: 'N2 login with no membership',
    action: 'orphan@alpha.local, a verified login with no membership, opened /projects/',
    observed: `data-outcome="${orphanOutcome}", text quotes ${JSON.stringify(orphanText.replaceAll(/\s+/gu, ' ').slice(0, 90))}`,
    ok: orphanOutcome === 'denied' && /AUTH_NO_MEMBERSHIP/u.test(orphanText),
    shot: await shot(orphanPage, 'N2-no-membership'),
  });
  await orphanContext.close();
}
