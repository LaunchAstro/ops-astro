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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { buildIdentifier } from '../../apps/web/build-stamp.ts';
import { BUILD_SELECTOR, servedBuildVerdict, stampInDocument } from './served-build.ts';

export const root = fileURLToPath(new URL('../..', import.meta.url));
// Screenshots and the results table default to a gitignored directory inside the
// repository, so anyone who clones it can run the checklist and read its
// evidence without first recreating someone else's local folder. `SHOT_DIR`
// still wins, which is how a run collects its evidence somewhere else.
export const SHOTS = process.env.SHOT_DIR ?? `${root}.local/evidence/browser`;
// **No default address (T4b1, spike RN-03).** This file used to fall back to
// the live demo's 5190 and 8790 when `WEB_URL` or `API_URL` was unset, and
// said so on stderr; three throwaway probes signed in and created tasks
// against another worktree's front end that way. A proof that can reach the
// demo is not a proof about the stack it meant, so both addresses are now
// required and a run without them is refused before anything starts.
const missing = ['WEB_URL', 'API_URL'].filter((name) => (process.env[name] ?? '') === '');
if (missing.length > 0) {
  throw new Error(`browser cases: set ${missing.join(' and ')}; there is no default address`);
}
export const WEB = process.env.WEB_URL;
export const API = process.env.API_URL;

/**
 * The port guard: one browser run per web and API port at a time. Each port
 * is claimed by a lock file under `.local/ports/` holding this process's pid,
 * created exclusively; a live holder refuses the run, a dead one's lock is
 * taken over. The locks go when this process exits.
 */
function claimPort(url) {
  const parsed = new URL(url);
  const fallback = parsed.protocol === 'https:' ? '443' : '80';
  const port = parsed.port === '' ? fallback : parsed.port;
  const lock = `${root}.local/ports/${port}.lock`;
  mkdirSync(`${root}.local/ports`, { recursive: true });
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = Number(readFileSync(lock, 'utf8'));
    if (holder !== process.pid && alive(holder)) {
      throw new Error(`browser cases: port ${port} is held by run pid ${String(holder)}`);
    }
    writeFileSync(lock, String(process.pid));
  }
  process.once('exit', () => rmSync(lock, { force: true }));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

claimPort(WEB);
claimPort(API);
export const DOCKER = process.env.DOCKER_BIN ?? '/usr/local/bin/docker';

// **What B6 stops.** Case B6 stops a Postgres container and the API process and
// brings both back, so the thing it stops is configuration, not a constant: a
// lane with a stack of its own names its container and volume, and the
// registered run, which names neither, gets today's live pair unchanged.
//
// Two names are refused before anything runs. The datafix database is another
// lane's evidence, and a `supabase_*` container is the Hub's; stopping either
// from a browser checklist is not a test of the slice. A container named
// without its volume is refused too, because B6 reports the volume it kept, and
// quietly reporting the live one beside someone else's container would be a
// false line in the results table.
const LIVE_PG = { container: 'ops-astro-local-pg', volume: 'ops-astro-local-pgdata' };
const DENIED_PG = new Set(['ops-astro-datafix-pg', 'ops-astro-datafix-pgdata']);
/** Docker's own shape for container and volume names. */
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

/**
 * The Postgres container and volume B6 restarts, and the port the API it
 * restarts listens on, which is `API_URL`'s. Throws on a refused name.
 */
export function restartTargetOf(env, apiUrl = API) {
  const named = env.B6_PG_CONTAINER;
  const container = named ?? LIVE_PG.container;
  const volume = env.B6_PG_VOLUME ?? (named === undefined ? LIVE_PG.volume : undefined);
  if (volume === undefined) {
    throw new Error(`B6 restart target: B6_PG_CONTAINER=${container} names no B6_PG_VOLUME`);
  }
  for (const name of [container, volume]) {
    // One Docker name and nothing else. An empty value, or two names run
    // together by a shell that did not split them, is not a name the deny list
    // can be trusted to have checked.
    if (!DOCKER_NAME.test(name)) {
      throw new Error(`B6 restart target: ${JSON.stringify(name)} is not one Docker name`);
    }
    if (DENIED_PG.has(name) || name.startsWith('supabase_')) {
      throw new Error(`B6 restart target: refusing ${name}; B6 never stops it`);
    }
  }
  const url = new URL(apiUrl);
  const apiPort = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { container, volume, apiPort, live: container === LIVE_PG.container };
}

// The application modules the page imports for the cases that must run through
// the app's own code. They are served by Vite to the browser, not resolvable
// from here, so they travel into `page.evaluate` as data rather than standing in
// this file as import specifiers.
export const IN_PAGE = {
  client: ['/src', 'operations', 'client.ts'].join('/'),
  submit: ['/src', 'records', 'submit.ts'].join('/'),
  authorisedRead: ['/src', 'data', 'authorised-read.ts'].join('/'),
};

/**
 * What the page was actually served, bound to the source it was served from.
 *
 * A run through the app's own modules is evidence about those modules only if
 * the run says which bytes they were. So this fetches, in the signed-in page and
 * through the same origin, the entry document, each module script it names, the
 * modules `IN_PAGE` imports and every `/src/` module the page has loaded, and
 * hashes each one as served. Beside them it records `git rev-parse HEAD` and
 * whether the tree had uncommitted changes. It prints one line per URL and
 * returns the same list, so a caller can write it into its receipt.
 */
export async function servedIdentity(page, label) {
  const head = sh('git', ['rev-parse', 'HEAD']).trim();
  const dirty = sh('git', ['status', '--porcelain']).trim() !== '';
  const modules = await page.evaluate(async (named) => {
    // Inside the page: serialised by Playwright, so it cannot close over this module.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const sha256 = async (bytes) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    const served = async (url) => {
      const bytes = await (await window.fetch(url, { cache: 'no-store' })).arrayBuffer();
      return { url, bytes: bytes.byteLength, sha256: await sha256(bytes) };
    };
    const entry = await served('/');
    const html = await (await window.fetch('/', { cache: 'no-store' })).text();
    const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    const loaded = performance
      .getEntriesByType('resource')
      .map((timing) => new URL(timing.name))
      .filter((url) => url.origin === window.location.origin && url.pathname.startsWith('/src/'))
      .map((url) => `${url.pathname}${url.search}`);
    const urls = [...new Set([...scripts, ...Object.values(named), ...loaded])].toSorted();
    return [entry, ...(await Promise.all(urls.map(async (url) => await served(url))))];
  }, IN_PAGE);
  for (const one of modules) {
    console.log(
      `served ${label} ${WEB}${one.url} sha256=${one.sha256} bytes=${String(one.bytes)} head=${head}${dirty ? ' (dirty)' : ''}`,
    );
  }
  return { label, web: WEB, head, dirty, modules };
}

/**
 * One checklist row's served line, matched against the version stamp (S0-1,
 * line C8; product issue 57).
 *
 * Called by I10, R4 and N6 on the page each one exercises, once it has drawn:
 * it prints `servedIdentity`'s lines and then the build line, and records a
 * row of its own. The stamp that page shows, the one its served entry document
 * carries and the one expected must all agree: the checkout's, or
 * `EXPECT_BUILD` for a run against a built artefact. A page with no stamp is a
 * red row. It never throws into the row that called it.
 */
export async function servedBuild(page, row) {
  const label = `${row.toLowerCase()}-served`;
  try {
    const identity = await servedIdentity(page, label);
    const shown = await page
      .locator(BUILD_SELECTOR)
      .first()
      .getAttribute('data-build', { timeout: 5_000 })
      .catch(() => null);
    const html = await page.evaluate(
      async () => await (await window.fetch('/', { cache: 'no-store' })).text(),
    );
    const expected = process.env.EXPECT_BUILD ?? buildIdentifier(root);
    const verdict = servedBuildVerdict({ label, shown, entry: stampInDocument(html), expected });
    console.log(verdict.line);
    record({
      case: `S0-1 served build ${row}`,
      action: 'the served line against the version stamp, on the page the row exercises',
      observed: verdict.line,
      ok: verdict.ok,
    });
    return { ...identity, build: verdict };
  } catch (error) {
    record({
      case: `S0-1 served build ${row}`,
      action: 'the served line against the version stamp, on the page the row exercises',
      observed: `threw: ${String(error).slice(0, 300)}`,
      ok: false,
    });
    return null;
  }
}

/** The viewport every context in the checklist is opened at. */
export const VIEWPORT = { width: 1480, height: 900 };

mkdirSync(SHOTS, { recursive: true });

export function fromEnvFile(name) {
  return (
    process.env[name] || readEnvFile(`${root}.local/db.env`, { required: true })[name] || undefined
  );
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
        origin: '',
        businessKey: ask.businessKey ?? session.businessKey,
        signedIn: true,
        subject: session.subject,
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
        origin: '',
        businessKey: session.businessKey,
        signedIn: true,
        subject: session.subject,
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
        `| ${entry.case} | ${entry.action} | ${entry.observed.replaceAll('\\', '\\\\').replaceAll('|', '\\|')} | ${verdictOf(entry)} | ${entry.shot ? entry.shot.replace(`${SHOTS}/`, '') : '—'} |`,
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
