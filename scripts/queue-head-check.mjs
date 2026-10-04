// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (#724): a pull request never runs its checks on a merge-queue
// commit. The queue builds each group on a branch in this repository,
// `gh-readonly-queue/<base>/pr-<n>-<sha>`. A pull request whose head is that
// branch's tip would report its checks on the group's own commit, beside the
// group's `merge_group` results; a pull request runs the light set, so its
// pass could land there before the group's full jobs report. It runs in two
// places. In ci.yml's gate, right after the sent-back hold, it fails the gate:
// every job that waits on the gate is skipped, and the `database conformance`
// aggregate, which runs always(), fails. In review-evidence.yml, a required
// check that waits on no gate, it runs before the evidence is judged and fails
// that job.
//
// It matches by commit, not by name: a fork can push the queue's commit under
// any branch name. It lists the queue branches' tips with
// `git ls-remote origin 'refs/heads/gh-readonly-queue/*'` in the checkout and
// fails when the pull request's head commit is one of them, exactly. A branch
// named `gh-readonly-queue/...` fails too, whatever its commit. On a pull
// request it fails closed: a head commit it cannot read, or a listing that
// fails, fails the run, and a re-run tries again. No queue branch at all is
// fine; there is nothing to match. Every other event passes without listing.
//
// It passes no token to git and prints none: on a failed listing it reports
// only git's exit status, not what git wrote.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'gh-readonly-queue/';
const QUEUE_REFS = `refs/heads/${PREFIX}`;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const LINE = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/iu;

/**
 * The queue branches' tips in `git ls-remote` output, in lower case. Each line
 * must be `<sha>\t<ref>`, or the listing is unreadable and this returns null.
 * Only a ref that starts `refs/heads/gh-readonly-queue/` counts; git's pattern
 * also prints a branch that has that path further in its name.
 */
export function queueTips(text) {
  const tips = new Set();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = LINE.exec(line);
    if (match === null) return null;
    if (match[2].startsWith(QUEUE_REFS)) tips.add(match[1].toLowerCase());
  }
  return tips;
}

/** The pull request's head commit, in lower case, and branch; null when either cannot be read. */
export function pullHead(payload) {
  const sha = payload?.pull_request?.head?.sha;
  const ref = payload?.pull_request?.head?.ref;
  if (typeof sha !== 'string' || !SHA.test(sha) || typeof ref !== 'string') return null;
  return { sha: sha.toLowerCase(), ref };
}

/** Why a pull request with this head must not run its checks, or null when it may. */
export function refusal(head, tips) {
  if (head.ref.startsWith(PREFIX))
    return `the pull request's branch '${head.ref}' is named like a merge-queue branch (${PREFIX})`;
  if (tips.has(head.sha))
    return `the pull request's head ${head.sha} is a merge-queue commit, the tip of a ${PREFIX} branch`;
  return null;
}

const fail = (message) => {
  console.error(`queue-head check: ${message}. No check runs on this head.`);
  return 1;
};

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  if (eventName !== 'pull_request') {
    console.log(
      `queue-head check: not a pull request (${eventName || 'no event'}); nothing to check`,
    );
    return 0;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH ?? '';
  let head = null;
  try {
    head = pullHead(JSON.parse(readFileSync(eventPath, 'utf8')));
  } catch {
    // Read as unreadable below.
  }
  if (head === null) return fail("cannot read the pull request's head commit from the event");
  const listing = spawnSync('git', ['ls-remote', 'origin', `${QUEUE_REFS}*`], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (listing.status !== 0)
    return fail(
      `could not list the merge-queue branches (git exit ${listing.status ?? listing.signal}); a re-run tries again`,
    );
  const tips = queueTips(listing.stdout);
  if (tips === null) return fail('could not list the merge-queue branches (unreadable listing)');
  const reason = refusal(head, tips);
  if (reason !== null) return fail(reason);
  console.log(`queue-head check: ${head.sha} is not a merge-queue commit; every check runs`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
