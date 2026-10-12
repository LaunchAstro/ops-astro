// SPDX-License-Identifier: AGPL-3.0-only
//
// Queue hygiene (owner, 12 October 2026): scripts/full-run.ts decides whether a ci.yml run takes
// the full set or the light one. A merge group is always full, a pull request is full only with
// the `ci-next` label, and a push to main is light only when a green merge group tested its exact
// tree and the queue still holds entries. Anything unread is full.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FULL, LABEL, LIGHT, queueBusyNow, scopeOf, testedBy } from '../../scripts/full-run.ts';

const REPO = 'LaunchAstro/ops-astro';
const TREE = 'a'.repeat(40);
const pr = (...labels: string[]) => ({
  pull_request: { labels: labels.map((name) => ({ name })) },
});

/** A run of ci.yml in the merge queue, on `tree`, as the runs list returns it. */
const run = (over: Record<string, unknown> = {}) => ({
  id: 1,
  event: 'merge_group',
  path: '.github/workflows/ci.yml',
  repository: { full_name: REPO },
  head_commit: { tree_id: TREE },
  status: 'completed',
  conclusion: 'success',
  ...over,
});

/** An API that answers the runs list with each page in turn, the last one for good. */
const pages = (...lists: unknown[][]) => {
  let read = 0;
  return () => Promise.resolve({ workflow_runs: lists[Math.min(read++, lists.length - 1)] });
};
const pause = () => Promise.resolve();

/** The runs list's count of groups queued and under test. */
const runs =
  (queued: number, going: number) =>
  (path: string): Promise<{ total_count: number }> =>
    Promise.resolve({ total_count: path.includes('status=queued') ? queued : going });
/** The merge queue's own count of entries. */
const queue = (count: number) => () =>
  Promise.resolve({ data: { repository: { mergeQueue: { entries: { totalCount: count } } } } });
/** A merge queue answer with no queue in it. */
const unread = () => Promise.resolve({ data: { repository: { mergeQueue: null } } });
/** A merge queue read the token may not make. */
const broken = () => Promise.reject(new Error('graphql: 403'));

describe('the scope of a run', () => {
  it('is full on every merge group, whatever else it is told', () => {
    for (const payload of [undefined, {}, pr(), pr(LABEL)])
      for (const tested of [true, false, undefined])
        for (const queueBusy of [true, false, undefined])
          expect(scopeOf({ eventName: 'merge_group', payload, tested, queueBusy })).toBe(FULL);
  });

  it('is full on a pull request with the ci-next label and light without it', () => {
    expect(scopeOf({ eventName: 'pull_request', payload: pr(LABEL) })).toBe(FULL);
    expect(scopeOf({ eventName: 'pull_request', payload: pr('needs-sol', LABEL) })).toBe(FULL);
    expect(scopeOf({ eventName: 'pull_request', payload: pr() })).toBe(LIGHT);
    expect(scopeOf({ eventName: 'pull_request', payload: pr('needs-sol', 'ci-next-x') })).toBe(
      LIGHT,
    );
  });

  it('is full on a pull request whose labels it cannot read', () => {
    expect(scopeOf({ eventName: 'pull_request', payload: {} })).toBe(FULL);
    expect(scopeOf({ eventName: 'pull_request', payload: { pull_request: {} } })).toBe(FULL);
    expect(scopeOf({ eventName: 'pull_request', payload: undefined })).toBe(FULL);
  });

  it('is light on a push only when a merge group tested the tree and the queue holds more', () => {
    expect(scopeOf({ eventName: 'push', tested: true, queueBusy: true })).toBe(LIGHT);
    expect(scopeOf({ eventName: 'push', tested: true, queueBusy: false })).toBe(FULL);
    expect(scopeOf({ eventName: 'push', tested: false, queueBusy: true })).toBe(FULL);
    expect(scopeOf({ eventName: 'push' })).toBe(FULL);
  });

  it('is full on any other event', () => {
    for (const eventName of ['', 'workflow_dispatch', 'schedule', 'pull_request_target'])
      expect(scopeOf({ eventName, payload: pr(), tested: true, queueBusy: true })).toBe(FULL);
  });
});

describe('the merge group that tested a tree', () => {
  it('is a green merge-group run of ci.yml in this repository on the same tree', async () => {
    const api = pages([run({ id: 7, head_commit: { tree_id: 'b'.repeat(40) } }), run({ id: 8 })]);
    expect((await testedBy({ api, repo: REPO, tree: TREE, pause }))?.id).toBe(8);
  });

  it('is none when the run on that tree failed, was cancelled, or ran elsewhere', async () => {
    const others = [
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { path: '.github/workflows/lookahead.yml' },
      { repository: { full_name: 'someone/ops-astro' } },
      { event: 'push' },
      { head_commit: { tree_id: 'c'.repeat(40) } },
      { head_commit: null },
    ];
    const found = await Promise.all(
      others.map(
        async (other) =>
          await testedBy({ api: pages([run(other)]), repo: REPO, tree: TREE, pause }),
      ),
    );
    expect(found.filter((one: unknown) => one !== undefined)).toStrictEqual([]);
  });
});

describe('a merge group still going on the tree', () => {
  it('waits for a run still going on that tree, and takes it once it is green', async () => {
    const api = pages([run({ status: 'in_progress', conclusion: null })], [run()]);
    expect((await testedBy({ api, repo: REPO, tree: TREE, pause }))?.id).toBe(1);
  });

  it('stops waiting after its last read and takes none', async () => {
    let pauses = 0;
    const api = pages([run({ status: 'in_progress', conclusion: null })]);
    const found = await testedBy({
      api,
      repo: REPO,
      tree: TREE,
      waits: 3,
      pause: () => {
        pauses += 1;
        return Promise.resolve();
      },
    });
    expect([found, pauses]).toStrictEqual([undefined, 3]);
  });

  it('takes none for a tree it could not read, even beside a run whose tree is unread too', async () => {
    const api = pages([run({ head_commit: null }), run({ head_commit: {} }), run()]);
    for (const tree of [undefined, ''])
      // eslint-disable-next-line no-await-in-loop -- two cases, each on its own read
      expect(await testedBy({ api, repo: REPO, tree, pause })).toBeUndefined();
  });
});

describe('whether the queue holds more', () => {
  it('holds more when the queue has an entry', async () => {
    expect(await queueBusyNow({ api: runs(0, 0), graphql: queue(3), repo: REPO })).toBe(true);
  });

  it('is empty when the queue has none and no group is being tested', async () => {
    expect(await queueBusyNow({ api: runs(0, 0), graphql: queue(0), repo: REPO })).toBe(false);
  });

  it('is empty when the queue has none, even while the run of a merged group is still going', async () => {
    // Two groups built at once can merge through the later one; the earlier run goes on until
    // it is cancelled, and the push it leaves is still the end of the batch.
    expect(await queueBusyNow({ api: runs(1, 0), graphql: queue(0), repo: REPO })).toBe(false);
    expect(await queueBusyNow({ api: runs(0, 1), graphql: queue(0), repo: REPO })).toBe(false);
  });

  it('holds none when the queue cannot be read, whatever runs are going', async () => {
    expect(await queueBusyNow({ api: runs(1, 0), graphql: broken, repo: REPO })).toBe(false);
    expect(await queueBusyNow({ api: runs(0, 1), graphql: broken, repo: REPO })).toBe(false);
    expect(await queueBusyNow({ api: runs(0, 0), graphql: broken, repo: REPO })).toBe(false);
    expect(await queueBusyNow({ api: runs(0, 1), graphql: unread, repo: REPO })).toBe(false);
  });
});

describe('the script as the gate runs it', () => {
  /** The scope the script writes for an event, with the payload as given and no reachable API. */
  function scopeFor(eventName: string, payload?: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'full-run-'));
    const output = join(dir, 'output');
    const event = join(dir, 'event.json');
    writeFileSync(output, '');
    if (payload !== undefined) writeFileSync(event, JSON.stringify(payload));
    try {
      const done = spawnSync(process.execPath, ['scripts/full-run.ts'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env['PATH'] ?? '',
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: REPO,
          GITHUB_SHA: 'd'.repeat(40),
          GH_TOKEN: 'synthetic-token',
          // Nothing listens here, so every read for a push fails.
          GITHUB_API_URL: 'http://127.0.0.1:9',
        },
      });
      expect(done.status, done.stderr).toBe(0);
      expect(done.stdout + done.stderr).not.toContain('synthetic-token');
      return readFileSync(output, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes full for a merge group and for a pull request with ci-next', () => {
    expect(scopeFor('merge_group', { merge_group: {} })).toBe('scope=full\n');
    expect(scopeFor('pull_request', pr(LABEL))).toBe('scope=full\n');
  });

  it('writes light for a pull request without ci-next', () => {
    expect(scopeFor('pull_request', pr('needs-sol'))).toBe('scope=light\n');
  });

  it('writes full when it cannot read the event or the API', () => {
    expect(scopeFor('pull_request')).toBe('scope=full\n');
    expect(scopeFor('push', { ref: 'refs/heads/main' })).toBe('scope=full\n');
  }, 60_000);
});
