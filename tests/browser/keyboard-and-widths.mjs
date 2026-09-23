// SPDX-License-Identifier: AGPL-3.0-only
//
// Two measurements a person would make with their hands, made the same way.
//
// **Keyboard only.** The whole journey -- sign in, board, create, open, assign,
// start, complete, reopen, title and due -- driven with Tab, Enter, Space and
// the arrows, and nothing else. No click, no `fill`, no `selectOption`: the
// only way a control is reached is by tabbing to it, so a control the tab order
// never visits cannot be operated and the table says so. Every step records the
// key pressed, the element that had focus when it was pressed, and what
// happened.
//
// **Widths.** `/projects/` and a task at 1480, 900 and 390, light and dark. The
// gaps against `docs/local/WEB.md` are written down, not fixed.
//
// Run: node tests/browser/keyboard-and-widths.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:5190';
const SHOTS =
  process.env.SHOT_DIR ??
  `${root}../ops-astro-roadmap/.local/ops-astro-build-run-2026-09-23/parent-observations/local-slice`;

const users = JSON.parse(readFileSync(`${root}.local/synthetic-users.json`, 'utf8'));
const mia = users.find((user) => user.email === 'mia@alpha.local');

const steps = [];
const step = (what) => {
  process.stderr.write(`kb: ${what}\n`);
};

/** What has focus, in the words a person would use to point at it. */
async function focused(page) {
  return await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return 'the document (nothing focused)';
    const name =
      el.getAttribute('aria-label') ??
      el.id ??
      (el.textContent ?? '').trim().slice(0, 30) ??
      el.tagName;
    return `<${el.tagName.toLowerCase()}> ${name}`;
  });
}

/**
 * Tab until the focused element matches, pressing at most `limit` times.
 *
 * Returns how many presses it took, which is the number a person would count,
 * or undefined when the tab order never reaches it -- a finding, not a crash.
 */
async function tabTo(page, selector, limit = 25, text) {
  for (let pressed = 1; pressed <= limit; pressed += 1) {
    // eslint-disable-next-line no-await-in-loop -- one key at a time is the point.
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const there = await page.evaluate(
      (want) =>
        (document.activeElement?.matches(want.css) ?? false) &&
        (want.text === undefined ||
          (document.activeElement?.textContent ?? '').trim() === want.text),
      { css: selector, text },
    );
    if (there) return pressed;
  }
  return undefined;
}

async function record(page, entry) {
  steps.push({ ...entry, focus: entry.focus ?? (await focused(page)) });
  const mark = entry.ok === false ? 'FAIL ' : 'ok   ';
  console.log(`${mark} ${entry.step.padEnd(28)} ${entry.key.padEnd(14)} ${entry.outcome}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1480, height: 900 } });
const page = await context.newPage();
const shot = async (name) => {
  const file = `${SHOTS}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
};

try {
  // ------------------------------------------------------------------ sign in
  step('sign in');
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#signin-email');
  const toEmail = await tabTo(page, '#signin-email');
  await page.keyboard.type(mia.email);
  await record(page, {
    step: 'reach the email field',
    key: `Tab x${String(toEmail)}`,
    outcome: toEmail === undefined ? 'never focused' : `typed ${mia.email}`,
    ok: toEmail !== undefined,
  });

  const toPassword = await tabTo(page, '#signin-password', 3);
  await page.keyboard.type(mia.password);
  await record(page, {
    step: 'reach the password field',
    key: `Tab x${String(toPassword)}`,
    outcome: toPassword === undefined ? 'never focused' : 'typed the password',
    ok: toPassword !== undefined,
  });

  const toBusiness = await tabTo(page, '#signin-business', 3);
  // A native select takes arrows. Down then Up settles on a real option
  // whichever way the list was ordered, and the value is read back.
  await page.keyboard.press('ArrowDown');
  const chosen = await page.inputValue('#signin-business');
  await record(page, {
    step: 'choose the business',
    key: `Tab x${String(toBusiness)}, ArrowDown`,
    outcome: `the select reads "${chosen}"`,
    ok: toBusiness !== undefined,
  });
  if (chosen !== mia.businessKey) {
    await page.keyboard.press('ArrowUp');
  }

  const kbSignIn = await shot('KB-1-signin-focus');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });
  await record(page, {
    step: 'submit the form',
    key: 'Enter',
    outcome: `landed on ${new URL(page.url()).pathname}`,
    ok: new URL(page.url()).pathname === '/projects/',
    shot: kbSignIn,
  });

  // ------------------------------------------------------------------- create
  step('create');
  const title = `Keyboard ${new Date().toISOString()}`;
  await page.waitForSelector('#create-title');
  const toTitle = await tabTo(page, '#create-title');
  await page.keyboard.type(title);
  await record(page, {
    step: 'reach the new-task title',
    key: `Tab x${String(toTitle)}`,
    outcome: toTitle === undefined ? 'never focused' : 'typed the title',
    ok: toTitle !== undefined,
  });
  await page.keyboard.press('Enter');
  const row = page.locator('a[href^="/task/"]', { hasText: title }).first();
  await row.waitFor({ timeout: 15_000 });
  await record(page, {
    step: 'create it',
    key: 'Enter',
    outcome: 'the board lists the new task',
    ok: true,
    shot: await shot('KB-2-created'),
  });

  // --------------------------------------------------------------------- open
  step('open');
  const href = await row.getAttribute('href');
  const toRow = await tabTo(page, `a[href="${href}"]`, 40);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-task]', { timeout: 15_000 });
  await record(page, {
    step: 'open the task',
    key: `Tab x${String(toRow)}, Enter`,
    outcome: toRow === undefined ? 'the row is not in the tab order' : `opened ${href}`,
    ok: toRow !== undefined,
    shot: await shot('KB-3-opened'),
  });

  // ------------------------------------------------------------------- assign
  step('assign');
  const beforeAssign = await page.locator('[data-revision]').first().getAttribute('data-revision');
  const toAssignee = await tabTo(page, 'select[aria-label="Assignee"]', 30);
  // On macOS a native select opens its popup on an arrow rather than moving the
  // value, so the person presses ArrowDown to open, ArrowDown to move and Enter
  // to take it. That is the platform's keyboard contract, not the app's.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const assigned = await page
    .waitForFunction(
      (was) => document.querySelector('[data-revision]')?.getAttribute('data-revision') !== was,
      beforeAssign,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  const afterAssign = await page.locator('[data-revision]').first().getAttribute('data-revision');
  await record(page, {
    step: 'assign the task',
    key: `Tab x${String(toAssignee)}, ArrowDown, ArrowDown, Enter`,
    outcome: assigned
      ? `revision ${beforeAssign} to ${afterAssign}`
      : `revision stayed ${beforeAssign}; the select did not commit from the keyboard`,
    ok: assigned,
    shot: await shot('KB-4-assigned'),
  });

  // ---------------------------------------------------------------- lifecycle
  for (const [label, key] of [
    ['Start', 'Space'],
    ['Complete', 'Enter'],
    ['Reopen', 'Space'],
  ]) {
    step(`lifecycle ${label}`);
    // eslint-disable-next-line no-await-in-loop -- each press waits on the one before.
    const was = await page.locator('[data-revision]').first().getAttribute('data-revision');
    // eslint-disable-next-line no-await-in-loop
    const reached = await tabTo(page, 'button', 30, label);
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press(key);
    // eslint-disable-next-line no-await-in-loop
    const moved = await page
      .waitForFunction(
        (before) =>
          document.querySelector('[data-revision]')?.getAttribute('data-revision') !== before,
        was,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    const now = await page.locator('[data-revision]').first().getAttribute('data-revision');
    // eslint-disable-next-line no-await-in-loop
    await record(page, {
      step: `${label.toLowerCase()} the task`,
      key: `Tab x${String(reached)}, ${key}`,
      outcome: moved ? `revision ${was} to ${now}` : `revision stayed ${was}`,
      ok: moved,
      // eslint-disable-next-line no-await-in-loop
      shot: await shot(`KB-5-${label.toLowerCase()}`),
    });
  }

  // ----------------------------------------------------------- title and due
  step('title and due');
  const wasEdit = await page.locator('[data-revision]').first().getAttribute('data-revision');
  const toTitleField = await tabTo(page, '#task-title', 30);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(`${title} edited`);
  const toDue = await tabTo(page, '#task-due', 4);
  await page.keyboard.type('09/29/2026');
  const toSave = await tabTo(page, 'button[type="submit"]', 6);
  await page.keyboard.press('Enter');
  const edited = await page
    .waitForFunction(
      (before) =>
        document.querySelector('[data-revision]')?.getAttribute('data-revision') !== before,
      wasEdit,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  await record(page, {
    step: 'edit the title and due date',
    key: `Tab x${String(toTitleField)} / x${String(toDue)} / x${String(toSave)}, Enter`,
    outcome: edited
      ? `revision ${wasEdit} to ${await page.locator('[data-revision]').first().getAttribute('data-revision')}`
      : `revision stayed ${wasEdit}`,
    ok: edited,
    shot: await shot('KB-6-edited'),
  });

  const taskKey = decodeURIComponent(href.replace('/task/', ''));
  console.log(`\nkeyboard steps: ${String(steps.length)}`);
  console.log(JSON.stringify(steps, undefined, 2));

  // -------------------------------------------------------------------- widths
  for (const width of [1480, 900, 390]) {
    for (const theme of ['light', 'dark']) {
      for (const [name, path] of [
        ['projects', '/projects/'],
        ['task', `/task/${encodeURIComponent(taskKey)}`],
      ]) {
        step(`width ${String(width)} ${theme} ${name}`);
        // eslint-disable-next-line no-await-in-loop -- one viewport at a time.
        await page.setViewportSize({ width, height: 900 });
        // eslint-disable-next-line no-await-in-loop
        await page.emulateMedia({ colorScheme: theme });
        // eslint-disable-next-line no-await-in-loop
        await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
        // eslint-disable-next-line no-await-in-loop
        await page.waitForSelector('[data-outcome]', { timeout: 15_000 });
        // eslint-disable-next-line no-await-in-loop
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        // eslint-disable-next-line no-await-in-loop
        const file = await shot(`width-${String(width)}-${theme}-${name}`);
        console.log(
          `width ${String(width)} ${theme.padEnd(5)} ${name.padEnd(8)} horizontal-overflow=${String(overflow)}  ${file}`,
        );
      }
    }
  }
} catch (error) {
  step(`stopped: ${String(error).slice(0, 300)}`);
  console.log(JSON.stringify(steps, undefined, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit(process.exitCode ?? 0);
}
