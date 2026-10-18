// SPDX-License-Identifier: AGPL-3.0-only
// The timing-failure rule (register item 50a, owner, 18 October 2026; #1857).
// On a merge group, a suite the group's diff does not touch that fails only on
// its tests runs once more in the same job (the queue drops a group the moment
// a required check fails, so a later re-run could not save it). A pass is
// logged as timing; a second failure blocks. A suite that has done this twice
// goes into .github/test-quarantine.json (the PostHog pattern), and while its
// ticket is open and its entry unexpired, a group that does not touch it
// leaves it out and .github/workflows/quarantine-nightly.yml runs it: the one
// exception to "no test dropped". It fails closed: a malformed, unticketed,
// over-14-day, future-dated, duplicate, isolation-suite or unnamed entry fails
// the shard, an unreadable ticket keeps its suite in, and a touched suite is
// never re-run or left out. scripts/db-conformance.mjs reads only the plan
// `prepare` writes, in a step of its own, so GH_TOKEN never reaches a suite.
//
// Usage: node scripts/timing-rule.ts prepare --out <file> [--nightly | --rerun-only]
//   GITHUB_EVENT_NAME  merge_group re-runs and leaves out; any other event
//                      neither. --nightly lists what sits out, for the nightly.
//   --rerun-only       re-runs, leaves nothing out and reads no ticket: the
//                      isolation shards, which hold no token (CQ-15).
//   GH_TOKEN           reads each entry's ticket; without it none sits out.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dependenciesOf } from './import-closure.ts';
import { readIsolationSuites, readNamedSuites } from './named-suites.ts';

export const QUARANTINE = '.github/test-quarantine.json';
const MAX_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

export interface QuarantineEntry {
  readonly test: string;
  readonly reason: string;
  readonly owner: string;
  readonly ticket: number;
  readonly added: string;
  readonly expires: string;
  readonly timing: readonly number[];
}

export type TicketState = 'open' | 'closed' | 'pull request' | 'missing' | 'unreadable';

/** What the runner may do on this run; scripts/db-conformance.mjs reads it. */
export interface RulePlan {
  readonly event: 'merge_group' | 'nightly' | 'other';
  readonly run: string;
  readonly pulls: readonly string[];
  readonly changed: readonly string[];
  readonly quarantined: readonly Pick<QuarantineEntry, 'test' | 'ticket' | 'owner' | 'expires'>[];
}

interface Suites {
  readonly named: readonly string[];
  readonly isolation: readonly string[];
}

const refuse = (why: string): never => {
  throw new Error(`${QUARANTINE}: ${why}`);
};
const badPlan = (why: string): never => {
  throw new Error(`timing-rule plan: ${why}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTexts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).toSorted().join() === keys.toSorted().join();

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[], where: string): void => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) refuse(`${where} has an unknown key "${key}"`);
  }
};

/** A calendar date, YYYY-MM-DD, as milliseconds; anything else is refused. */
const day = (value: unknown, what: string): number => {
  const text = typeof value === 'string' ? value : '';
  const at = /^\d{4}-\d{2}-\d{2}$/u.test(text) ? Date.parse(`${text}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text) {
    refuse(`${what} must be a calendar date written YYYY-MM-DD`);
  }
  return at;
};

const ENTRY_KEYS = ['test', 'reason', 'owner', 'ticket', 'added', 'expires', 'timing'];
const LISTED_KEYS = ['test', 'ticket', 'owner', 'expires'] as const;

function readEntry(value: unknown, where: string, suites: Suites, today: number): QuarantineEntry {
  if (!isRecord(value)) return refuse(`${where} must be an object`);
  onlyKeys(value, ENTRY_KEYS, where);
  const { test, reason, owner, ticket, added, expires, timing } = value;
  if (typeof test !== 'string' || !suites.named.includes(test)) {
    refuse(`${where}.test must be a named suite's path`);
  }
  if (suites.isolation.includes(String(test))) {
    refuse(`${where}.test is an isolation suite, which never leaves the merge group`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') refuse(`${where}.reason must be given`);
  if (typeof owner !== 'string' || !/^[A-Za-z\d][A-Za-z\d-]{0,38}$/u.test(owner)) {
    refuse(`${where}.owner must be a GitHub login`);
  }
  if (typeof ticket !== 'number' || !Number.isSafeInteger(ticket) || ticket < 1) {
    refuse(`${where}.ticket must be the number of the issue that fixes it`);
  }
  const from = day(added, `${where}.added`);
  const until = day(expires, `${where}.expires`);
  if (from > today) refuse(`${where}.added is in the future`);
  if (until <= from) refuse(`${where}.expires must be after ${where}.added`);
  if (until - from > MAX_DAYS * DAY)
    refuse(`${where} is out for more than ${String(MAX_DAYS)} days`);
  if (!Array.isArray(timing) || timing.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    refuse(`${where}.timing must list the run ids its timing failures were seen in`);
  }
  if (new Set(timing as unknown[]).size < 2) refuse(`${where}.timing must name two different runs`);
  // Every key is known and checked, so the object is the entry.
  return value as unknown as QuarantineEntry;
}

/** Every entry of the quarantine file, or an error naming the first thing wrong. */
export function readQuarantine(text: string, suites: Suites, today: string): QuarantineEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return refuse(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return refuse('must hold a JSON object');
  onlyKeys(parsed, ['comment', 'tests'], 'the file');
  if (!isTexts(parsed['comment'] ?? [])) refuse('"comment" must be a list of strings');
  const tests = parsed['tests'];
  if (!Array.isArray(tests)) return refuse('"tests" must be a list');
  const now = day(today, 'today');
  const entries = tests.map((value, i) => readEntry(value, `tests[${String(i)}]`, suites, now));
  const seen = new Set<string>();
  for (const { test } of entries) {
    if (seen.has(test)) refuse(`${test} is listed twice`);
    seen.add(test);
  }
  return entries;
}

/** A ticket's state from the issues API's answer, or unreadable without one. */
export function ticketState(response?: { status: number; body: unknown }): TicketState {
  if (response === undefined) return 'unreadable';
  if (response.status === 404 || response.status === 410) return 'missing';
  if (response.status !== 200 || !isRecord(response.body)) return 'unreadable';
  if (response.body['pull_request'] !== undefined) return 'pull request';
  const { state } = response.body;
  return state === 'open' || state === 'closed' ? state : 'unreadable';
}

/**
 * The entries whose suites sit out today: unexpired, ticket open. A closed,
 * expired or unreadable one puts its suite back, with a note why; a ticket that
 * is a pull request or does not exist is refused.
 */
export function activeEntries(
  entries: readonly QuarantineEntry[],
  today: string,
  states: ReadonlyMap<number, TicketState>,
): { active: QuarantineEntry[]; notes: string[] } {
  const active: QuarantineEntry[] = [];
  const notes: string[] = [];
  for (const entry of entries) {
    const state = states.get(entry.ticket) ?? 'unreadable';
    const ticket = `#${String(entry.ticket)}`;
    const back = `${entry.test} is back in the merge group`;
    if (state === 'pull request') refuse(`${ticket} is a pull request, not a ticket`);
    if (state === 'missing') refuse(`${ticket} does not exist`);
    if (today >= entry.expires) notes.push(`${back}: its entry expired on ${entry.expires}`);
    else if (state === 'closed') notes.push(`${back}: ${ticket} is closed, so remove its entry`);
    else if (state === 'unreadable') notes.push(`${back}: ${ticket} could not be read`);
    else active.push(entry);
  }
  return { active, notes };
}

/** The plan `prepare` wrote; anything that is not one is refused. */
export function readRulePlan(text: string): RulePlan {
  let plan: unknown;
  try {
    plan = JSON.parse(text);
  } catch {
    return badPlan('is not valid JSON');
  }
  if (!isRecord(plan) || !sameKeys(plan, ['event', 'run', 'pulls', 'changed', 'quarantined'])) {
    return badPlan('must hold exactly event, run, pulls, changed and quarantined');
  }
  const { event, run, pulls, changed, quarantined } = plan;
  if (event !== 'merge_group' && event !== 'nightly' && event !== 'other') badPlan('unknown event');
  if (typeof run !== 'string' || !isTexts(pulls) || !isTexts(changed)) {
    badPlan('run, pulls and changed must be text');
  }
  const listed = (entry: unknown): boolean =>
    isRecord(entry) &&
    sameKeys(entry, LISTED_KEYS) &&
    typeof entry['ticket'] === 'number' &&
    ['test', 'owner', 'expires'].every((key) => typeof entry[key] === 'string');
  if (!Array.isArray(quarantined) || !quarantined.every((entry) => listed(entry))) {
    badPlan('quarantined entries must each hold test, ticket, owner and expires');
  }
  return plan as unknown as RulePlan;
}

/** Whether a change reaches a suite: the file itself, or anything it reaches through imports or names. */
export function touchedBy(root: string, suite: string, changed: readonly string[]): boolean {
  const reached = [suite, ...dependenciesOf(root, suite)];
  return changed.some((path) => reached.some((dep) => path === dep || path.startsWith(`${dep}/`)));
}

const repoRoot = resolve(import.meta.dirname, '..');

/** Each entry's ticket, from the API. Any failure to read leaves it unreadable. */
async function readTickets(entries: readonly QuarantineEntry[]): Promise<Map<number, TicketState>> {
  const token = process.env['GH_TOKEN'] ?? '';
  const api = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
  const repository = process.env['GITHUB_REPOSITORY'] ?? '';
  const states = new Map<number, TicketState>();
  for (const { ticket } of entries) {
    if (token === '' || repository === '') continue;
    // eslint-disable-next-line no-await-in-loop
    const answer = await fetch(`${api}/repos/${repository}/issues/${String(ticket)}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (response) => ({ status: response.status, body: await response.json() }))
      .catch(() => ({ status: 0, body: null }));
    states.set(ticket, ticketState(answer));
  }
  return states;
}

/** The group's pull requests and every path it changes against main as it stands. */
function readGroup(): { pulls: string[]; changed: string[] } {
  const run = (file: string, args: string[]): string[] =>
    execFileSync(file, args, { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
  const lines = run(process.execPath, ['scripts/merge-group.mjs', 'list']).map((l) => l.split(' '));
  const base = lines[0]?.[2] ?? '';
  if (!/^[0-9a-f]{40}$/u.test(base)) throw new Error('the merge group named no base.');
  return {
    pulls: lines.map(([number]) => number ?? ''),
    changed: run('git', ['diff', '--no-renames', '--name-only', base, 'HEAD']),
  };
}

async function prepare(argv: readonly string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
  if (out === undefined) throw new Error('prepare needs --out <file>.');
  const nightly = argv.includes('--nightly');
  const rerunOnly = argv.includes('--rerun-only');
  if (nightly && rerunOnly) throw new Error('--nightly and --rerun-only do not go together.');
  const group = process.env['GITHUB_EVENT_NAME'] === 'merge_group' && !nightly;
  const event = nightly ? 'nightly' : group ? 'merge_group' : 'other';
  const today = new Date().toISOString().slice(0, 10);
  const named = readNamedSuites(repoRoot);
  const isolation = readIsolationSuites(repoRoot).invariant;
  const suites = { named: [...named.invariant, ...named.conformance], isolation };
  const entries = readQuarantine(
    readFileSync(resolve(repoRoot, QUARANTINE), 'utf8'),
    suites,
    today,
  );
  const { active, notes } =
    event === 'other' || rerunOnly
      ? { active: [], notes: [] }
      : activeEntries(entries, today, await readTickets(entries));
  for (const note of notes) console.log(`::warning title=quarantine::${note}`);
  const plan: RulePlan = {
    event,
    run: `${process.env['GITHUB_RUN_ID'] ?? 'local'}/${process.env['GITHUB_RUN_ATTEMPT'] ?? '1'}`,
    ...(group ? readGroup() : { pulls: [], changed: [] }),
    quarantined: active.map(({ test, ticket, owner, expires }) => ({
      test,
      ticket,
      owner,
      expires,
    })),
  };
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`timing-rule: ${event}; ${String(active.length)} quarantined suite(s) sit out.`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command !== 'prepare') throw new Error(`unknown command ${String(command)}; use prepare.`);
    await prepare(rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::timing-rule: ${message.replaceAll(/\s+/gu, ' ')}`);
    process.exit(1);
  }
}
