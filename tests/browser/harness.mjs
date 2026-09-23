// SPDX-License-Identifier: AGPL-3.0-only
//
// What every browser case group needs: where the slice is served, how a person
// signs in, how a call is made through the application's own modules in the
// page, and where the results table is written.
//
// The case groups next to this file each own one part of the checklist and
// share nothing but this module and the run context the entry point builds.
//
// **Nothing here seeds a task.** Every record the checklist reasons about is
// one it created during the run, with a title carrying the run's own timestamp,
// so a row already in the database cannot make a case pass.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
// Screenshots and the results table default to a gitignored directory inside the
// repository, so anyone who clones it can run the checklist and read its
// evidence without first recreating someone else's local folder. `SHOT_DIR`
// still wins, which is how a run collects its evidence somewhere else.
export const SHOTS = process.env.SHOT_DIR ?? `${root}.local/evidence/browser`;
export const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:5190';
export const API = process.env.API_URL ?? 'http://127.0.0.1:8790';
export const DOCKER = process.env.DOCKER_BIN ?? '/usr/local/bin/docker';

// The application modules the page imports for the cases that must run through
// the app's own code. They are served by Vite to the browser, not resolvable
// from here, so they travel into `page.evaluate` as data rather than standing in
// this file as import specifiers.
export const IN_PAGE = {
  client: ['/src', 'operations', 'client.ts'].join('/'),
  submit: ['/src', 'records', 'submit.ts'].join('/'),
  authorisedRead: ['/src', 'data', 'authorised-read.ts'].join('/'),
};

/** The viewport every context in the checklist is opened at. */
export const VIEWPORT = { width: 1480, height: 900 };

mkdirSync(SHOTS, { recursive: true });

export function fromEnvFile(name) {
  if (process.env[name]) return process.env[name];
  for (const line of readFileSync(`${root}.local/db.env`, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.+)$`, 'u').exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

export const users = JSON.parse(readFileSync(`${root}.local/synthetic-users.json`, 'utf8'));
export const passwordOf = (email) => users.find((user) => user.email === email)?.password;

export const results = [];

/**
 * A case's verdict. `pending` still labels a case whose sibling behaviour has
 * not landed, because the label is what makes a partial run readable — but a
 * pending or unrun row is counted against the command, not excused by it. See
 * `writeResults`.
 */
const verdictOf = (entry) =>
  entry.pending
    ? `pending ${entry.pending}`
    : entry.ok === undefined
      ? 'unrun'
      : entry.ok
        ? 'pass'
        : 'FAIL';

export function record(entry) {
  results.push(entry);
  console.log(
    `${verdictOf(entry).toUpperCase().padEnd(6)} ${entry.case.padEnd(34)} ${entry.observed}`,
  );
}

/**
 * The exit status a module that advertises a standalone run owes its caller.
 *
 * A standalone entry that awaits its cases, catches errors into a row and then
 * exits without consulting the rows it just wrote reports success for a run
 * that printed FAIL. Anything reading that exit code -- a person, a later
 * script, a checklist -- reads a failed run as an accepted one. So the status
 * is computed from the same `results` the table is: every recorded row must
 * have passed, *and* every required case must be among them, because a group
 * that threw before reaching SX3 recorded no SX3 row at all and an absent row
 * is not a pass. `writeResults` counts the same three things for the full
 * runner; this is that rule for a module run on its own.
 *
 * It returns the status rather than exiting, so a caller can still decide.
 */
export function standaloneStatus(group, required) {
  const short = results.filter((entry) => entry.pending || entry.ok !== true);
  const absent = required.filter(
    (name) => !results.some((entry) => entry.case.startsWith(name) && entry.ok === true),
  );
  const status = short.length + absent.length === 0 ? 0 : 1;
  console.log(
    `\n${group}: ${String(results.length - short.length)}/${String(results.length)} row(s) passed` +
      `${absent.length === 0 ? '' : `, ${absent.join(', ')} never recorded a passing row`}` +
      ` — exit ${String(status)}`,
  );
  return status;
}

export async function shot(page, name) {
  const file = `${SHOTS}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export const sh = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * One step after another, in the order given, collecting what each returns.
 *
 * The checklist's sequences are not independent -- each step reads the revision
 * the step before it left -- so they cannot go out together. This recurses
 * rather than looping because a loop that awaits its own body is the shape the
 * repository's lint rules reject, and the rule is right about the usual case.
 */
export async function inOrder(items, step, done = []) {
  if (items.length === 0) return done;
  const [first, ...rest] = items;
  return await inOrder(rest, step, [...done, await step(first)]);
}

/** Wait until the record on the screen is past the revision it was at. */
export async function pastRevision(page, was) {
  await page.waitForFunction(
    (prior) => Number(document.querySelector('[data-revision]')?.dataset.revision) > prior,
    was,
    { timeout: 15_000 },
  );
}

/** The revision the screen is drawing. */
export const revisionOn = async (page) =>
  Number(await page.locator('[data-revision]').first().getAttribute('data-revision'));

/** Sign in through the real form, as a person does. */
export async function signIn(page, email, businessKey) {
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#signin-email');
  await page.fill('#signin-email', email);
  await page.fill('#signin-password', passwordOf(email));
  await page.selectOption('#signin-business', businessKey);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });
}

/**
 * A call made by the application's own modules, in the page, with the session
 * the person signed in with. `records/submit.ts` is the generic submission the
 * checklist names for N3; the client is the one the screens use.
 */
export async function throughSubmit(page, request) {
  return await page.evaluate(
    async (ask) => {
      const { OperationsClient } = await import(ask.modules.client);
      const { submitEdit } = await import(ask.modules.submit);
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const client = new OperationsClient({
        base: '/api',
        businessKey: ask.businessKey ?? session.businessKey,
        token: session.token,
        fetch: window.fetch.bind(window),
      });
      return await submitEdit(client, ask.request);
    },
    { ...request, modules: IN_PAGE },
  );
}

export async function throughClient(page, ask) {
  return await page.evaluate(
    async (given) => {
      const { OperationsClient } = await import(given.modules.client);
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const sent = [];
      const spy = async (input, init) => {
        sent.push({
          url: String(input),
          headers: Object.keys(init?.headers ?? {}),
          body: init?.body,
        });
        return await window.fetch(input, init);
      };
      const client = new OperationsClient({
        base: '/api',
        businessKey: session.businessKey,
        token: session.token,
        fetch: spy,
      });
      const result = given.read
        ? await client.read(given.name, given.body)
        : await client.mutate(given.name, given.body, given.options ?? {});
      return { result, sent };
    },
    { ...ask, modules: IN_PAGE },
  );
}

/** The outcome a screen settles on. `loading` is where every read starts. */
export async function outcomeOf(page) {
  await page.waitForSelector('[data-outcome]', { timeout: 15_000 });
  await page
    .waitForFunction(
      () => document.querySelector('[data-outcome]')?.dataset.outcome !== 'loading',
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  return await page.locator('[data-outcome]').first().getAttribute('data-outcome');
}

/** The revision the record is actually at, read back through the app's client. */
export async function serverRevision(page, recordId) {
  const { result } = await throughClient(page, {
    read: true,
    name: 'task.read',
    body: { recordId },
  });
  return result.ok === true ? result.value.task.revision : undefined;
}

/** The whole task, read back through the app's client, or undefined if refused. */
export async function serverTask(page, recordId) {
  const { result } = await throughClient(page, {
    read: true,
    name: 'task.read',
    body: { recordId },
  });
  return result.ok === true ? result.value.task : undefined;
}

/** The business's unboarded tasks, read back through the app's client. */
export async function serverBoard(page) {
  const { result } = await throughClient(page, {
    read: true,
    name: 'task.board',
    body: { board: null },
  });
  return result.ok === true ? result.value.tasks : undefined;
}

/** Close a pool that may already be closed, without losing anyone else's failure. */
export async function closeQuietly(pool) {
  try {
    await pool.close();
  } catch {
    /* already closed */
  }
}

/**
 * The results table a person reads, and the exit code the one command needs.
 *
 * Returns the number of rows that did not pass: failed, pending and unrun
 * together. A pending or unrun row is not a pass. The earlier version returned
 * only `failed.length`, so a run that never reached a required case — or
 * recorded it as pending a sibling lane — exited zero, and anything reading the
 * exit code of `pnpm verify:browser` read an incomplete run as an accepted one.
 * The table below still separates the three so a partial run can be diagnosed;
 * it is only the count that stops forgiving them.
 */
export function writeResults(given) {
  const pending = results.filter((entry) => entry.pending);
  const ran = results.filter((entry) => !entry.pending && entry.ok !== undefined);
  const failed = ran.filter((entry) => !entry.ok);
  const unrun = results.length - ran.length - pending.length;
  const lines = [
    '# Browser acceptance results',
    '',
    `Run ${given.stamp} against ${WEB} (API ${API}). Task \`${given.taskKey ?? 'none'}\` / \`${given.taskId ?? 'none'}\`, title generated at run time.`,
    '',
    '| Case | Action | Observed | Result | Screenshot |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (entry) =>
        `| ${entry.case} | ${entry.action} | ${entry.observed.replaceAll(/\|/gu, '\\|')} | ${verdictOf(entry)} | ${entry.shot ? entry.shot.replace(`${SHOTS}/`, '') : '—'} |`,
    ),
    '',
    `${ran.length - failed.length}/${ran.length} passed, ${failed.length} failed, ${unrun} unrun, ${pending.length} pending a sibling lane.`,
    '',
  ];
  writeFileSync(`${SHOTS}/RESULTS.md`, `${lines.join('\n')}\n`);
  const short = failed.length + pending.length + unrun;
  console.log(
    `\nwrote ${SHOTS}/RESULTS.md — ${ran.length - failed.length}/${ran.length} passed, ${failed.length} failed, ${unrun} unrun, ${pending.length} pending; ${short} row(s) short of acceptance`,
  );
  return short;
}
