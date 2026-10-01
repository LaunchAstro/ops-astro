// SPDX-License-Identifier: AGPL-3.0-only
// The pull requests a check judges: on a pull request, itself; on a merge
// group, every pull request the group holds, each against the base branch.
//
// GitHub's merge queue builds a group on a temporary branch,
// `gh-readonly-queue/<base>/pr-<n>-<sha>`, that holds the base branch and,
// one merge commit each, every pull request queued so far. A `merge_group`
// event carries no pull request, and its ref names only the last one, so
// the group is read from git: from the head, along first parents, down to
// the base branch's tip as it stands, every commit must be the queue's merge
// of one pull request (`Merge pull request #<n> from ...`, two parents, the
// second the pull request's head). A pull request already merged sits below
// that tip and has left the group. Anything else fails closed: a check that
// cannot tell which pull requests it judges does not pass the group.
//
// The event's `base_sha` is not read: the base tip is fetched, so an entry
// whose own checks never ran is judged here too, whatever the queue's
// "only merge non-failing pull requests" setting.
//
//   node scripts/merge-group.mjs list
//     One line per pull request, oldest first: `<number> <head> <base>`.
//   node scripts/merge-group.mjs base
//     The base every pull request is judged against.
//   node scripts/merge-group.mjs each [--pulls <dir>] <command> [args...]
//     Runs the command once per pull request, with PR_NUMBER, HEAD_SHA and
//     BASE_SHA set, and fails if any run fails, after running every one.
//     With --pulls, <dir>/pr-<n>/pull.json is the pull request as the API
//     reads it now: it must be that pull request, at that head (and, on a
//     group, open and on the group's base branch), and PR_BODY and PR_LABELS
//     come from it.
//
// It reads GITHUB_EVENT_NAME and GITHUB_EVENT_PATH and runs git in the
// working directory. It needs no token.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`::error::merge-group: ${message.replaceAll(/\s+/gu, ' ')}`);
  process.exit(1);
};

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const isAncestor = (a, b) =>
  spawnSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }).status === 0;

const SHA = /^[0-9a-f]{40}$/u;
const MERGE = /^Merge pull request #(\d{1,7}) from \S+$/u;

/** The event as GitHub wrote it. */
function event() {
  const name = process.env['GITHUB_EVENT_NAME'] ?? '';
  const path = process.env['GITHUB_EVENT_PATH'] ?? '';
  if (path === '') fail('GITHUB_EVENT_PATH is not set.');
  return { name, payload: JSON.parse(readFileSync(path, 'utf8')) };
}

/** On a pull request: the event's own. */
function fromPullRequest(payload) {
  const pr = payload.pull_request ?? {};
  const [number, head, base] = [String(pr.number ?? ''), pr.head?.sha ?? '', pr.base?.sha ?? ''];
  if (!/^\d+$/u.test(number) || !SHA.test(head) || !SHA.test(base))
    fail('the pull_request event names no pull request, head or base.');
  return { branch: pr.base?.ref ?? '', pulls: [{ number, head, base }] };
}

/** On a merge group: every pull request between the base tip and the head. */
function fromMergeGroup(payload) {
  const group = payload.merge_group ?? {};
  const head = group.head_sha ?? '';
  const branch = /^refs\/heads\/(.+)$/u.exec(group.base_ref ?? '')?.[1];
  if (!SHA.test(head) || branch === undefined)
    fail('the merge_group event names no head or base branch.');
  const ref = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-(\d+)-[0-9a-f]{40}$/u.exec(
    group.head_ref ?? '',
  );
  if (ref === null) fail(`${group.head_ref} is not a merge queue ref.`);
  if (ref[1] !== branch) fail(`${group.head_ref} is not a queue for ${group.base_ref}.`);

  git('fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${branch}`);
  const base = git('rev-parse', 'FETCH_HEAD');
  if (!isAncestor(base, head))
    fail(`the tip of ${branch}, ${base}, is not an ancestor of the group's head ${head}.`);

  // Newest first: each line `<sha> <parent> [<parent>...]`.
  const chain = git('rev-list', '--first-parent', '--parents', `${base}..${head}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  if (chain.length === 0) fail(`the group at ${head} holds no pull request.`);
  if (chain.at(-1)?.[1] !== base)
    fail(`the group's first commit does not sit on the tip of ${branch}, ${base}.`);

  const seen = new Set();
  const pulls = chain.toReversed().map(([sha, ...parents]) => {
    if (parents.length !== 2) fail(`${sha} is not a merge of two parents.`);
    const subject = git('log', '-1', '--format=%s', sha);
    const number = MERGE.exec(subject)?.[1];
    if (number === undefined) fail(`${sha} names no pull request: "${subject}".`);
    if (seen.has(number)) fail(`#${number} appears twice in the group.`);
    seen.add(number);
    return { number, head: parents[1], base };
  });
  if (pulls.at(-1)?.number !== ref[2])
    fail(
      `${group.head_ref} names pull request #${ref[2]}, and its head merges #${pulls.at(-1)?.number}.`,
    );
  return { branch, pulls };
}

function judged() {
  const { name, payload } = event();
  if (name === 'pull_request') return { group: false, ...fromPullRequest(payload) };
  if (name === 'merge_group') return { group: true, ...fromMergeGroup(payload) };
  return fail(`a ${name || 'missing'} event holds no pull request to judge.`);
}

/** The pull request as the API reads it now, held to the one being judged. */
function readPull(dir, pull, branch, group) {
  const json = JSON.parse(readFileSync(join(dir, `pr-${pull.number}`, 'pull.json'), 'utf8'));
  const problems = [];
  if (String(json.number) !== pull.number) problems.push(`the record read is #${json.number}`);
  if (json.head?.sha !== pull.head) problems.push(`it is at ${json.head?.sha}, not ${pull.head}`);
  if (group && json.state !== 'open') problems.push(`it is ${json.state}`);
  if (group && json.base?.ref !== branch) problems.push(`it targets ${json.base?.ref}`);
  if (problems.length > 0) return { problems };
  return {
    env: {
      PR_BODY: json.body ?? '',
      PR_LABELS: (json.labels ?? []).map((l) => l.name).join('\n'),
    },
  };
}

const [command, ...rest] = process.argv.slice(2);
const { group, branch, pulls } = judged();

if (command === 'list') {
  for (const p of pulls) console.log(`${p.number} ${p.head} ${p.base}`);
} else if (command === 'base') {
  console.log(pulls[0]?.base);
} else if (command === 'each') {
  const dir = rest[0] === '--pulls' ? rest[1] : undefined;
  const argv = dir === undefined ? rest : rest.slice(2);
  if (argv.length === 0) fail('each needs a command to run.');
  const failed = [];
  for (const pull of pulls) {
    console.log(`merge-group: #${pull.number} at ${pull.head}, against ${pull.base}`);
    const read = dir === undefined ? { env: {} } : readPull(dir, pull, branch, group);
    if (read.problems !== undefined) {
      console.error(`::error::merge-group: #${pull.number}: ${read.problems.join('; ')}.`);
      failed.push(pull.number);
      continue;
    }
    const env = {
      ...process.env,
      ...read.env,
      PR_NUMBER: pull.number,
      HEAD_SHA: pull.head,
      BASE_SHA: pull.base,
    };
    const run = spawnSync(argv[0], argv.slice(1), { env, stdio: 'inherit' });
    if (run.status !== 0) failed.push(pull.number);
  }
  if (failed.length > 0) fail(`failed for ${failed.map((n) => `#${n}`).join(', ')}.`);
} else {
  fail(`unknown command ${command}; use list, base or each.`);
}
