// SPDX-License-Identifier: AGPL-3.0-only
//
// R1: retrying a create whose outcome nobody knows (review finding 1) in the
// real browser, against the real API.
//
// **The server must actually commit the task.** Aborting the request before the
// API sees it would prove nothing -- there would be no first task for a retry
// to duplicate. So the first `task.create` is forwarded to the real API with
// `route.fetch()`, its committed response is received here, and only then is
// the response dropped, so the form is told `unavailable` about a create that
// has already happened. That is the ambiguous outcome the finding is about.
//
// Then the person presses Retry, which is the same submit button once an
// attempt is unresolved: the form presents the same operation id and the same
// payload, the server's replay register answers with the original outcome, and
// there must still be exactly one task.
//
// Nothing here is a test-only hook in the product. `data-attempt` is the
// button's own state -- it says whether the next press is a retry or a new
// task, which is what its label already tells a person.

import { WEB, record, serverBoard, serverTask, shot } from './harness.mjs';

const CREATE = '**/api/b/alpha/task/create';

/** Forward the first create to the API, keep its answer, and drop it. */
async function dropTheFirstAnswer(page) {
  const seen = { forwarded: 0, committed: null };
  await page.route(CREATE, async (route) => {
    if (seen.forwarded > 0) {
      await route.continue();
      return;
    }
    seen.forwarded += 1;
    const response = await route.fetch();
    seen.committed = { status: response.status(), body: (await response.text()).slice(0, 200) };
    await route.abort('connectionfailed');
  });
  return seen;
}

async function ambiguousCreate(page, title, seen) {
  await page.fill('#create-title', title);
  await page.click('form.projects__create button[type="submit"]');
  await page.waitForSelector('form.projects__create button[data-attempt="retry"]', {
    timeout: 20_000,
  });
  const said = await page.locator('form.projects__create .field__error').first().innerText();
  const label = await page
    .locator('form.projects__create button[data-attempt="retry"]')
    .first()
    .innerText();
  record({
    case: 'R1 a committed create loses its response',
    action: `forwarded the first ${CREATE.replace('**', '')} to the API, received its answer, then dropped it`,
    observed: `the API committed (HTTP ${seen.committed?.status ?? 'none'}), the form says ${JSON.stringify(said.replaceAll(/\s+/gu, ' ').slice(0, 80))} and offers "${label.trim()}"`,
    // The wording of the outage is the client's and may change. What this case
    // turns on is that the API committed and the form is now holding an
    // unresolved attempt -- which is what `data-attempt="retry"` says.
    ok: seen.committed?.status === 200 && label.trim() === 'Retry create',
    shot: await shot(page, 'R1-unavailable-after-commit'),
  });
}

async function retryTheSameAttempt(page, title) {
  await page.click('form.projects__create button[data-attempt="retry"]');
  await page.waitForSelector('form.projects__create button[data-attempt="new"]', {
    timeout: 20_000,
  });
  const rows = page.locator(`a[href^="/task/"]`, { hasText: title });
  await rows.first().waitFor({ timeout: 20_000 });
  const onBoard = await rows.count();
  record({
    case: 'R1 the retry does not make a second task',
    action: 'clicked Retry create, which presents the same attempt',
    observed: `${onBoard} row(s) on the board carry "${title}"; the form is back to a new attempt`,
    ok: onBoard === 1,
    shot: await shot(page, 'R1-retried-once'),
  });
}

async function oneTaskAndOneCreate(page, title, state) {
  const board = await serverBoard(page);
  const mine = (board ?? []).filter((task) => task.title === title);
  state.retryKey = mine[0]?.key;
  state.retryId = mine[0]?.id;
  record({
    case: 'R1 task.board agrees with the screen',
    action: 'read task.board through the application client in the page',
    observed: `${mine.length} task(s) titled "${title}"${state.retryKey ? ` — ${state.retryKey} / ${state.retryId}` : ''}`,
    ok: mine.length === 1,
    shot: await shot(page, 'R1-board-has-one'),
  });

  const task = state.retryId === undefined ? undefined : await serverTask(page, state.retryId);
  const creates = (task?.history ?? []).filter((entry) => /create/iu.test(entry.operation));
  record({
    case: 'R1 one applied create in the history',
    action: `read task.read for ${state.retryKey ?? 'the retried task'} and counted its create entries`,
    observed:
      task === undefined
        ? 'the task could not be read back'
        : `${creates.length} create entr(y/ies) of ${task.history.length} history rows: ${JSON.stringify(creates.map((entry) => entry.operation))}`,
    ok: creates.length === 1,
    shot: await shot(page, 'R1-one-create-in-history'),
  });
}

export async function casesCreateRetry(run) {
  const { page, state } = run;
  const title = `Retry ${run.stamp}`;

  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#create-title');

  const seen = await dropTheFirstAnswer(page);
  await ambiguousCreate(page, title, seen);
  await retryTheSameAttempt(page, title);
  await page.unroute(CREATE);
  await oneTaskAndOneCreate(page, title, state);
}
