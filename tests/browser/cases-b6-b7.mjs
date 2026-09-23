// SPDX-License-Identifier: AGPL-3.0-only
//
// B7 and B6: the slice is not a picture of a slice.
//
// B7 stops the API under a mounted page: the board must say `unavailable` and
// draw nothing, because a board that fell back to sample rows while the server
// was down would be indistinguishable from one that was working. B6 then stops
// the API *and* the database container, brings both back with the volume kept,
// and opens the task again in a browser that has never seen it.
//
// These two run last and they are why the N6 block above them is fenced.

import { readFileSync } from 'node:fs';
import {
  DOCKER,
  VIEWPORT,
  WEB,
  outcomeOf,
  record,
  revisionOn,
  root,
  sh,
  shot,
  signIn,
} from './harness.mjs';

/** Start the API detached, exactly as `scripts/local/api-up.sh` does. */
const API_UP = `. ./.local/db.env; . ./.local/auth.env; export DATABASE_URL DATABASE_ADMIN_URL SUPABASE_JWT_SECRET GOTRUE_URL API_PORT; nohup node apps/api/server.ts >> .local/api.log 2>&1 & echo $! > .local/api.pid`;

const apiPid = () => readFileSync(`${root}.local/api.pid`, 'utf8').trim();
const settle = async (ms) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

export async function casesB6toB7(run) {
  await casesB7(run);
  await caseB6(run);
}

async function casesB7(run) {
  const { page } = run;
  const stopped = apiPid();
  sh('/bin/kill', [stopped]);
  await settle(1500);
  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-outcome]');
  const downOutcome = await outcomeOf(page);
  const rowsWhileDown = await page.locator('a[href^="/task/"]').count();
  record({
    case: 'B7 unavailable is not empty',
    action: `stopped the API (pid ${stopped}) and reloaded /projects/`,
    observed: `data-outcome="${downOutcome}", ${rowsWhileDown} task rows drawn, no sample data`,
    ok: downOutcome === 'unavailable' && rowsWhileDown === 0,
    shot: await shot(page, 'B7-unavailable'),
  });

  sh('/bin/sh', ['-c', API_UP]);
  await settle(3000);
  const restoredPid = apiPid();
  await page
    .getByRole('button', { name: /retry|try again/iu })
    .first()
    .click()
    .catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
    });
  await page.waitForSelector('a[href^="/task/"]', { timeout: 20_000 });
  record({
    case: 'B7 retry after restore',
    action: `restarted the API (pid ${restoredPid}) and retried the read`,
    observed: `data-outcome="${await outcomeOf(page)}", ${await page.locator('a[href^="/task/"]').count()} rows`,
    ok: (await page.locator('a[href^="/task/"]').count()) > 0,
    shot: await shot(page, 'B7-restored'),
  });
}

async function caseB6(run) {
  const { browser, database, admin, state } = run;
  const prePid = apiPid();
  const preContainer = sh(DOCKER, ['inspect', '-f', '{{.Id}}', 'ops-astro-local-pg']).trim();
  sh('/bin/kill', [prePid]);
  await database.close();
  await admin.close();
  sh('/bin/bash', ['scripts/local/db-down.sh']);
  sh('/bin/bash', ['scripts/local/db-up.sh']);
  sh('/bin/sh', ['-c', API_UP]);
  await settle(6000);
  const postPid = apiPid();
  const postContainer = sh(DOCKER, ['inspect', '-f', '{{.Id}}', 'ops-astro-local-pg']).trim();
  const volume = sh(DOCKER, [
    'volume',
    'inspect',
    '-f',
    '{{.CreatedAt}}',
    'ops-astro-local-pgdata',
  ]).trim();

  const afterRestart = await browser.newContext({ viewport: VIEWPORT });
  const restartPage = await afterRestart.newPage();
  await signIn(restartPage, 'mia@alpha.local', 'alpha');
  await restartPage.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await restartPage.waitForSelector('[data-task]', { timeout: 20_000 });
  const survived = {
    title: await restartPage.locator('h2.tpr__title').innerText(),
    id: await restartPage.locator('[data-task]').first().getAttribute('data-task'),
    revision: String(await revisionOn(restartPage)),
    due: await restartPage.inputValue('#task-due'),
    assignee: await restartPage.locator('select[aria-label="Assignee"]').inputValue(),
    history: await restartPage.locator('.sbact__row').count(),
  };
  record({
    case: 'B6 process and database restart',
    action: `API ${prePid} -> ${postPid}; container ${preContainer.slice(0, 12)} -> ${postContainer.slice(0, 12)}; volume ops-astro-local-pgdata kept (created ${volume})`,
    observed: JSON.stringify(survived),
    ok: survived.title === state.edited && survived.id === state.taskId && survived.history >= 4,
    shot: await shot(restartPage, 'B6-after-restart'),
  });
  await afterRestart.close();
}
