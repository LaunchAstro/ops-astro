// SPDX-License-Identifier: AGPL-3.0-only
//
// C1-C2: a comment said in a real browser, and a member who may not say one.
//
// **This group creates the task it talks about.** Every record it reasons about
// carries the run's own timestamp in its title, so a row already in the
// database cannot make a case pass, and nothing here touches a task somebody
// else's case owns.
//
// C1 is the whole round trip: ada writes a comment, the screen posts it through
// `task.comment`, rereads the task, and the comment is on the page with its
// audience. Then the page is hard-reloaded — a new document, a new read, no
// state carried — and it is still there, which is the only version of "it was
// stored" a browser can prove.
//
// C2 is the refusal. `mia@alpha.local` is seeded with `task` read, write and
// assign and **not** `comment` (`scripts/local-seed.mjs`), so she can open the
// task and cannot say anything on it. There is no grant read in this build, so
// the screen cannot know that before it asks: it asks once, quotes
// `SCOPE_NOT_GRANTED` as the server said it, and closes the box. The case
// counts the requests the page makes, so "closed" means no second request
// rather than a greyed-out button that still fires.
//
// Run: node tests/browser/cases-comments.mjs  (or through slice-acceptance)

import { chromium } from 'playwright';
import { VIEWPORT, WEB, record, shot, signIn, standaloneStatus } from './harness.mjs';

/** The rows a standalone run has to have passed before it may exit zero. */
const REQUIRED = ['C1', 'C2'];

const POST = '[data-comment="post"]';

/** The task this group makes for itself, so it never writes on anyone else's. */
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

export async function casesComments(run) {
  // Its own context. This group signs in as two people in turn, and a shared
  // page would carry the first one's session into the second one's case.
  const context = await run.browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await comments(page, run);
  } finally {
    await context.close();
  }
}

async function comments(page, run) {
  const title = `Comments ${run.stamp}`;
  const said = `A note written by the browser at ${run.stamp}`;

  await signIn(page, 'ada@alpha.local', 'alpha');
  const task = await createTask(page, title);
  run.state.commentTaskKey = task.key;

  // The task starts with nothing said on it, which the screen draws as an
  // absence rather than as a list it could not read.
  const before = await page.locator('[data-comment-id]').count();

  await page.fill('#comment-body', said);
  await page.selectOption('#comment-audience', 'internal');
  await page.selectOption('#comment-kind', 'note');
  await page.click(POST);
  await page
    .waitForFunction((had) => document.querySelectorAll('[data-comment-id]').length > had, before, {
      timeout: 15_000,
    })
    .catch(() => undefined);

  const posted = await page.locator('[data-comment-id]').count();
  record({
    case: 'C1 a comment is posted and drawn',
    action: `ada wrote an internal note on ${task.key}`,
    observed: `the list went from ${before} to ${posted} comment(s)`,
    ok: posted === before + 1,
    shot: await shot(page, 'C1-comment-posted'),
  });

  // A hard reload: a new document, a fresh `task.read`, nothing carried from
  // the page that wrote it. This is what "it was stored" means in a browser.
  await page.goto(`${WEB}${task.href}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]', { timeout: 15_000 });
  const row = page.locator('[data-comment-id]').first();
  const audience = await row.getAttribute('data-audience').catch(() => null);
  const body = await row.innerText().catch(() => '');
  record({
    case: 'C1 it survives a reload, with its audience',
    action: `hard-reloaded ${task.href}`,
    observed: `the comment reads audience="${audience}" and ${
      body.includes(said) ? 'carries the text that was typed' : `carries "${body.slice(0, 80)}"`
    }`,
    ok: audience === 'internal' && body.includes(said),
    shot: await shot(page, 'C1-comment-after-reload'),
  });

  await mia(page, task);
}

/** A member with every task grant except `comment`, asking once. */
async function mia(page, task) {
  await page.context().clearCookies();
  await page.evaluate(() => {
    sessionStorage.clear();
  });
  await signIn(page, 'mia@alpha.local', 'alpha');
  await page.goto(`${WEB}${task.href}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]', { timeout: 15_000 });

  // Count what the page actually sends, so "the box is closed" is a fact about
  // requests and not about a disabled attribute that a click might ignore.
  const sent = [];
  page.on('request', (request) => {
    if (request.url().includes('/task/comment')) sent.push(request.url());
  });

  await page.fill('#comment-body', 'A note mia is not permitted to write.');
  await page.click(POST);
  await page
    .waitForSelector('[data-comment="refusal"]', { timeout: 15_000 })
    .catch(() => undefined);
  const quoted = await page
    .locator('[data-comment="refusal"]')
    .innerText()
    .catch(() => '');
  const afterFirst = sent.length;

  // The control is closed. A second press must reach nothing.
  await page.click(POST, { force: true }).catch(() => undefined);
  await page.waitForTimeout(500);
  const disabled = await page.locator(POST).isDisabled();
  const bodyDisabled = await page.locator('#comment-body').isDisabled();

  record({
    case: 'C2 a member without the comment grant is refused, once',
    action: 'mia opened the same task and pressed Post, then pressed it again',
    observed:
      `the screen quoted "${quoted.slice(0, 90)}"; the form is ` +
      `${disabled && bodyDisabled ? 'closed' : 'still open'}; ` +
      `${String(afterFirst)} request(s) before the second press, ${String(sent.length)} after`,
    ok:
      quoted.includes('SCOPE_NOT_GRANTED') &&
      disabled &&
      bodyDisabled &&
      afterFirst === 1 &&
      sent.length === 1,
    shot: await shot(page, 'C2-comment-refused'),
  });

  // And the refusal did not take the task with it: the read is still ready and
  // the comment ada wrote is still on the page (B7 — no sample data, and no
  // blank screen either).
  const drawing = await page.locator('[data-comment-id]').count();
  const outcome = await page.locator('[data-outcome]').first().getAttribute('data-outcome');
  record({
    case: 'C2 the refused write did not empty the screen',
    action: 'read the page mia is still looking at',
    observed: `the read is "${outcome}" and ${String(drawing)} comment(s) are drawn`,
    ok: outcome === 'ready' && drawing === 1,
    shot: await shot(page, 'C2-task-still-drawn'),
  });
}

// ------------------------------------------------------------------ standalone

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const run = { browser, stamp: new Date().toISOString(), state: {} };
  try {
    await casesComments(run);
  } catch (error) {
    record({
      case: 'C run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
  }
  console.log(`task created by this run: ${String(run.state.commentTaskKey)}`);
  process.exitCode = standaloneStatus('comments', REQUIRED);
}
