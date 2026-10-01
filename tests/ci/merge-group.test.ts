// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-QUEUE: the required checks run in GitHub's merge queue and hold on a group the claim they
// hold on a pull request. scripts/merge-group.mjs finds each pull request a group holds from the
// queue's own merge commits, between the base branch's tip and the group's head, and runs a check
// once per pull request, each against the base branch. Anything it cannot read fails closed.
// The payload fixtures are tests/ci/fixtures/merge-group-*.json, filled with this repository's shas.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, group, payload, repo, run, type Repo } from './merge-group-repo.ts';

afterAll(cleanup);

const refused: [string, (r: Repo) => string, RegExp][] = [
  [
    'the queue ref names another pull request than the head merges',
    (r) => group(r.dir, r.g12, `13-${r.main}`),
    /names pull request #13/u,
  ],
  [
    'the queue ref is for another base branch',
    (r) => group(r.dir, r.g12, `12-${r.main}`, 'develop'),
    /refs\/heads\/develop/u,
  ],
  [
    'the queue ref is not a merge queue ref',
    (r) =>
      payload(r.dir, 'merge-group-event.json', {
        HEAD: r.g12,
        HEAD_REF: 'refs/heads/pr12',
        BASE_REF: 'refs/heads/main',
      }),
    /not a merge queue ref/u,
  ],
  [
    'a commit between the base and the head is not a merge',
    (r) => {
      r.git('checkout', '-q', 'queue');
      const tip = r.commit('c.txt', 'Merge pull request #14 from LaunchAstro/squashed');
      return group(r.dir, tip, `14-${r.main}`);
    },
    /not a merge of two parents/u,
  ],
  [
    'a merge that names no pull request',
    (r) => {
      r.git('checkout', '-q', '-b', 'pr15', r.main);
      r.commit('d.txt', 'feat: d');
      r.git('checkout', '-q', 'queue');
      return group(r.dir, r.merge('pr15', 'Merge branch pr15'), `15-${r.main}`);
    },
    /names no pull request/u,
  ],
  [
    'the same pull request twice',
    (r) => {
      r.git('checkout', '-q', '-b', 'pr16', r.main);
      r.commit('e.txt', 'feat: e');
      r.git('checkout', '-q', 'queue');
      return group(
        r.dir,
        r.merge('pr16', 'Merge pull request #12 from LaunchAstro/pr16'),
        `12-${r.main}`,
      );
    },
    /#12 appears twice/u,
  ],
  [
    'the base tip is not under the head',
    (r) => {
      r.git('checkout', '-q', 'main');
      r.commit('f.txt', 'docs: moved on');
      return group(r.dir, r.g12, `12-${r.main}`);
    },
    /is not an ancestor/u,
  ],
  [
    'a group that holds no pull request',
    (r) => group(r.dir, r.main, `11-${r.main}`),
    /holds no pull request/u,
  ],
];

const echo = [
  'each',
  'sh',
  '-c',
  'echo "$PR_NUMBER $HEAD_SHA $BASE_SHA" >> runs.txt; [ "$PR_NUMBER" != "$FAIL" ]',
];

const pull = (over: Record<string, unknown>, number: number, head: string) => ({
  number,
  state: 'open',
  head: { sha: head },
  base: { ref: 'main' },
  body: `body of #${number}`,
  labels: [{ name: 'needs-sol' }, { name: 'x' }],
  ...over,
});

const show = [
  'each',
  '--pulls',
  '.',
  'sh',
  '-c',
  'printf "%s|%s|%s\\n" "$PR_NUMBER" "$PR_BODY" "$PR_LABELS" >> seen.txt',
];

const stale: [string, Record<string, unknown>, RegExp][] = [
  ['has moved past the head the group merges', { head: { sha: '0'.repeat(40) } }, /is at 0{40}/u],
  ['is closed', { state: 'closed' }, /is closed/u],
  ['targets another branch', { base: { ref: 'develop' } }, /targets develop/u],
  ['is another pull request', { number: 99 }, /#99/u],
];

describe('merge group: the pull requests a group holds', () => {
  it('lists every pull request in the group, oldest first, each with its head and the base tip', () => {
    const r = repo();
    const out = run(r.dir, 'merge_group', group(r.dir, r.g12, `12-${r.main}`), ['list']);
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`11 ${r.pr11} ${r.main}\n12 ${r.pr12} ${r.main}\n`);
  });

  it('on a pull request, lists that pull request against its base, as the event names them', () => {
    const r = repo();
    const event = payload(r.dir, 'pull-request-event.json', { HEAD: r.pr11, BASE: r.main });
    const out = run(r.dir, 'pull_request', event, ['list']);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`11 ${r.pr11} ${r.main}\n`);
  });

  it('a pull request already merged leaves the group: the base tip may be an earlier entry', () => {
    const r = repo();
    r.git('update-ref', 'refs/heads/main', r.g11);
    const out = run(r.dir, 'merge_group', group(r.dir, r.g12, `12-${r.main}`), ['list']);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`12 ${r.pr12} ${r.g11}\n`);
  });

  for (const [name, make, why] of refused) {
    it(`fails closed: ${name}`, () => {
      const r = repo();
      const out = run(r.dir, 'merge_group', make(r), ['list']);
      expect(out.status).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toMatch(why);
    });
  }

  it('fails closed on any other event', () => {
    const r = repo();
    const out = run(r.dir, 'push', group(r.dir, r.g12, `12-${r.main}`), ['list']);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/push/u);
  });
});

describe('merge group: a check run once per pull request', () => {
  it('runs the command for every pull request with its own head and the base tip, and passes when all pass', () => {
    const r = repo();
    const out = run(r.dir, 'merge_group', group(r.dir, r.g12, `12-${r.main}`), echo, { FAIL: '' });
    expect(out.status).toBe(0);
    expect(readFileSync(join(r.dir, 'runs.txt'), 'utf8')).toBe(
      `11 ${r.pr11} ${r.main}\n12 ${r.pr12} ${r.main}\n`,
    );
  });

  it('fails when one pull request fails, after running every one, and names it', () => {
    const r = repo();
    const out = run(r.dir, 'merge_group', group(r.dir, r.g12, `12-${r.main}`), echo, {
      FAIL: '11',
    });
    expect(out.status).toBe(1);
    expect(readFileSync(join(r.dir, 'runs.txt'), 'utf8').split('\n')).toHaveLength(3);
    expect(out.stderr).toMatch(/#11/u);
  });

  it('runs nothing and fails when the group cannot be read', () => {
    const r = repo();
    const out = run(r.dir, 'merge_group', group(r.dir, r.g12, `13-${r.main}`), echo, { FAIL: '' });
    expect(out.status).toBe(1);
    expect(() => readFileSync(join(r.dir, 'runs.txt'))).toThrow();
  });
});

describe('merge group: each pull request read as it stands', () => {
  function withPulls(over: Record<number, Record<string, unknown>> = {}) {
    const r = repo();
    for (const [n, head] of [
      [11, r.pr11],
      [12, r.pr12],
    ] as const) {
      mkdirSync(join(r.dir, `pr-${n}`));
      writeFileSync(
        join(r.dir, `pr-${n}`, 'pull.json'),
        JSON.stringify(pull(over[n] ?? {}, n, head)),
      );
    }
    return { r, out: run(r.dir, 'merge_group', group(r.dir, r.g12, `12-${r.main}`), show) };
  }

  it("hands each run its own pull request's body and labels", () => {
    const { r, out } = withPulls();
    expect(out.status).toBe(0);
    expect(readFileSync(join(r.dir, 'seen.txt'), 'utf8')).toBe(
      '11|body of #11|needs-sol\nx\n12|body of #12|needs-sol\nx\n',
    );
  });

  for (const [name, over, why] of stale) {
    it(`fails closed when the pull request ${name}`, () => {
      const { out } = withPulls({ 12: over });
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(why);
    });
  }
});
