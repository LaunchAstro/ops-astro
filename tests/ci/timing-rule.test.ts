// SPDX-License-Identifier: AGPL-3.0-only
//
// Register item 50a (owner, 18 October 2026), the quarantine half of the
// timing-failure rule (#1857): which entries of .github/test-quarantine.json
// hold a suite out of the merge group, which are refused outright, and when a
// change touches a suite. The runner's half, the one re-run and the suites a
// group leaves out, is proved against a real database in
// tests/ci/db-conformance-timing-rule.test.ts.

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readIsolationSuites, readNamedSuites } from '../../scripts/named-suites.ts';
import {
  activeEntries,
  readQuarantine,
  readRulePlan,
  ticketState,
  touchedBy,
  type QuarantineEntry,
  type TicketState,
} from '../../scripts/timing-rule.ts';

const root = resolve(import.meta.dirname, '../..');
const FLAKY = 'tests/ci/agent-login-provider-phase-rejudges.test.ts';
const ISOLATED = 'tests/isolation/client-isolation.test.ts';
const suites = { named: [FLAKY, 'tests/ci/other.test.ts', ISOLATED], isolation: [ISOLATED] };
const today = '2026-10-20';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  test: FLAKY,
  reason: 'samples a promise state on a timer instead of observing the lock wait',
  owner: 'Nathan-Mulligan',
  ticket: 1798,
  added: '2026-10-18',
  expires: '2026-11-01',
  timing: [39095428326, 39097222489],
  ...overrides,
});
const file = (...tests: unknown[]): string => JSON.stringify({ comment: ['why'], tests });
const read = (text: string): QuarantineEntry[] => readQuarantine(text, suites, today);

/** The listed entry under a ticket in `state`, on `on`. */
const sitsOut = (state: TicketState, on = today): { active: QuarantineEntry[]; notes: string[] } =>
  activeEntries(read(file(entry())), on, new Map([[1798, state]]));

describe('a quarantine entry that holds a suite out of the merge group', () => {
  it('admits a whole entry, and it sits out while its ticket is open and it has not expired', () => {
    expect(read(file(entry())).map((e) => e.test)).toStrictEqual([FLAKY]);
    expect(sitsOut('open').active.map((e) => e.test)).toStrictEqual([FLAKY]);
  });

  it('puts the suite back in the merge group when its ticket is closed', () => {
    expect(sitsOut('closed').active).toStrictEqual([]);
    expect(sitsOut('closed').notes.join('\n')).toContain('#1798 is closed');
  });

  it('puts the suite back in the merge group on its expiry day', () => {
    expect(sitsOut('open', '2026-10-31').active).toHaveLength(1);
    expect(sitsOut('open', '2026-11-01').active).toStrictEqual([]);
    expect(sitsOut('open', '2026-11-01').notes.join('\n')).toContain('expired on 2026-11-01');
  });

  it('keeps the suite in the merge group when its ticket cannot be read', () => {
    expect(sitsOut('unreadable').active).toStrictEqual([]);
    expect(sitsOut('unreadable').notes.join('\n')).toContain('could not be read');
  });

  it('refuses a ticket that is a pull request or does not exist', () => {
    expect(() => sitsOut('pull request')).toThrow(/#1798 is a pull request, not a ticket/u);
    expect(() => sitsOut('missing')).toThrow(/#1798 does not exist/u);
  });
});

describe('a ticket read from the issues API', () => {
  it.each([
    [200, { state: 'open' }, 'open'],
    [200, { state: 'closed' }, 'closed'],
    [200, { state: 'open', pull_request: {} }, 'pull request'],
    [404, {}, 'missing'],
    [410, {}, 'missing'],
    [403, {}, 'unreadable'],
    [200, { state: 'weird' }, 'unreadable'],
  ])('answered %i %j is %s', (status, body, state) => {
    expect(ticketState({ status, body })).toBe(state);
  });
  it('is unreadable with no answer', () => {
    expect(ticketState()).toBe('unreadable');
  });
});

describe('prepare reads each ticket the committed file names', () => {
  // The database shards hold no token (CQ-16); this public repository's issues need none.
  it.each([
    ['with no token, as on the database shards', ''],
    ['and never sends a token the environment holds', 'synthetic-token'],
  ])('%s', async (_name, token) => {
    const seen: { url: string | undefined; authorization: string | undefined }[] = [];
    const api = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: 'open' }));
    });
    await once(api.listen(0, '127.0.0.1'), 'listening');
    const scratch = mkdtempSync(join(tmpdir(), 'timing-rule-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['scripts/timing-rule.ts', 'prepare', '--nightly', '--out', join(scratch, 'plan.json')],
        {
          cwd: root,
          env: {
            ...process.env,
            GH_TOKEN: token,
            GITHUB_API_URL: `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`,
            GITHUB_REPOSITORY: 'LaunchAstro/ops-astro',
          },
        },
      );
      const listed = JSON.parse(readFileSync(join(root, '.github/test-quarantine.json'), 'utf8'))
        .tests as { ticket: number }[];
      expect(seen).toStrictEqual(
        listed.map(({ ticket }) => ({
          url: `/repos/LaunchAstro/ops-astro/issues/${String(ticket)}`,
          authorization: undefined,
        })),
      );
      expect(stdout).not.toContain('could not be read');
      expect(stdout).not.toContain('synthetic-token');
    } finally {
      api.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a malformed quarantine file fails closed', () => {
  const refused: [string, string, RegExp][] = [
    ['text that is not JSON', '{"tests": [', /not valid JSON/u],
    ['an unknown top-level key', JSON.stringify({ tests: [], skip: [] }), /unknown key "skip"/u],
    ['tests that are not a list', JSON.stringify({ tests: {} }), /"tests" must be a list/u],
    ['an entry with an unknown key', file(entry({ until: 'fixed' })), /unknown key "until"/u],
    ['an entry with no reason', file(entry({ reason: ' ' })), /reason/u],
    ['an entry with no owner', file(entry({ owner: undefined })), /owner/u],
    ['an owner that is not a GitHub login', file(entry({ owner: 'Nathan M' })), /owner/u],
    ['an unticketed entry', file(entry({ ticket: undefined })), /ticket/u],
    ['a ticket of zero', file(entry({ ticket: 0 })), /ticket/u],
    ['a ticket written as text', file(entry({ ticket: '1798' })), /ticket/u],
    ['a date that is not on the calendar', file(entry({ added: '2026-02-30' })), /added/u],
    ['a date with a time', file(entry({ expires: '2026-11-01T00:00:00Z' })), /expires/u],
    [
      'an entry out for more than 14 days',
      file(entry({ expires: '2026-11-02' })),
      /more than 14 days/u,
    ],
    ['an entry that expires before it is added', file(entry({ expires: '2026-10-17' })), /after/u],
    [
      'an entry added in the future',
      file(entry({ added: '2026-10-21', expires: '2026-10-30' })),
      /future/u,
    ],
    ['the same suite twice', file(entry(), entry()), /listed twice/u],
    ['an isolation suite', file(entry({ test: ISOLATED })), /isolation suite/u],
    ['a path that is not a named suite', file(entry({ test: 'tests/ci/gone.test.ts' })), /named/u],
    ['one timing run', file(entry({ timing: [39095428326] })), /two different/u],
    ['the same run twice', file(entry({ timing: [39095428326, 39095428326] })), /two different/u],
    ['a run id that is not a number', file(entry({ timing: ['a', 'b'] })), /timing/u],
  ];
  it.each(refused)('refuses %s', (_, text, why) => {
    expect(() => read(text)).toThrow(why);
  });
});

describe('the committed quarantine file', () => {
  it('lists the #1798 lock-wait test alone, while #1800 is unmerged, and validates', () => {
    const named = readNamedSuites(root);
    const entries = readQuarantine(
      readFileSync(join(root, '.github/test-quarantine.json'), 'utf8'),
      {
        named: [...named.invariant, ...named.conformance],
        isolation: readIsolationSuites(root).invariant,
      },
      new Date().toISOString().slice(0, 10),
    );
    expect(
      entries.map(({ test, owner, ticket, timing }) => ({ test, owner, ticket, timing })),
    ).toStrictEqual([
      { test: FLAKY, owner: 'Nathan-Mulligan', ticket: 1798, timing: [39095428326, 39097222489] },
    ]);
  });
});

describe('the plan the runner reads', () => {
  const plan = {
    event: 'merge_group',
    run: '1/1',
    pulls: ['1800'],
    changed: [],
    quarantined: [{ test: FLAKY, ticket: 1798, owner: 'Nathan-Mulligan', expires: '2026-11-01' }],
  };
  it('reads a whole plan', () => {
    expect(readRulePlan(JSON.stringify(plan))).toStrictEqual(plan);
  });
  it.each([
    ['not JSON', 'nope'],
    ['an unknown event', JSON.stringify({ ...plan, event: 'pull_request' })],
    ['a missing list', JSON.stringify({ ...plan, changed: undefined })],
    ['an unknown key', JSON.stringify({ ...plan, rerun: 'always' })],
    ['a changed path that is not text', JSON.stringify({ ...plan, changed: [1] })],
    [
      'a quarantined entry with no ticket',
      JSON.stringify({ ...plan, quarantined: [{ test: FLAKY }] }),
    ],
  ])('refuses %s', (_, text) => {
    expect(() => readRulePlan(text)).toThrow(/timing-rule plan/u);
  });
});

describe('a change touches a suite', () => {
  it('when it changes the suite itself', () => {
    expect(touchedBy(root, FLAKY, [FLAKY])).toBe(true);
  });
  it('when it changes a file the suite reaches through its imports', () => {
    expect(touchedBy(root, FLAKY, ['tests/ci/agent-login-provider.fixture.ts'])).toBe(true);
  });
  it('when it changes a file under a directory the suite names', () => {
    expect(touchedBy(root, FLAKY, ['apps/api/auth/new-file.ts'])).toBe(true);
  });
  it('and not when it changes only files the suite never reaches', () => {
    expect(touchedBy(root, FLAKY, ['docs/product-identity.md', 'CONTRIBUTING.md'])).toBe(false);
  });
});
