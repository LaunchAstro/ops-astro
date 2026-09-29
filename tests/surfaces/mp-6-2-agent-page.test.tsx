// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2, the Agent page's named tests over lineages shaped exactly as
// `task.read` returns them: the run hero (TA-01), artefact versions with their
// supersedes chain and two check counts (TA-05, D-18), the append-only
// activity log (TA-06), the side column (TA-08, TA-09) and the agent's own
// writing drawn as text. The server half (the run's start and the gate's
// raised time in the proposals' snapshot) is proven against Postgres in
// `tests/api/mp-6-2-agent-page.test.ts`.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunLineage } from '../../packages/ui/src/index.ts';
import { lineage, pane, running, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';
import type { Mounted } from './mount.tsx';

afterEach(unmountAll);

type Check = RunLineage['versions'][number]['checks'][number];

const check = (id: string, outcome: string, at: string, name = `check ${id}`): Check => ({
  id,
  name,
  outcome,
  note: null,
  performedByActorId: 'agent-1',
  recordedAt: at,
});

const staged = (title: string) => ({
  staged: {
    kind: 'pr',
    repo: 'agency/site',
    number: 42,
    title,
    files: 2,
    adds: 10,
    dels: 3,
    checks: 'green',
    href: 'https://example.test/pr/42',
  },
});

const CHECKS: readonly Check[] = [
  check('c1', 'passed', '2026-09-29T09:10:00.000Z'),
  check('c2', 'passed', '2026-09-29T09:20:00.000Z'),
  check('c3', 'failed', '2026-09-29T09:30:00.000Z'),
  check('c4', 'passed', '2026-09-29T09:40:00.000Z'),
  check('c5', 'inconclusive', '2026-09-29T09:50:00.000Z'),
];

/** v1 approved and run from 09:00; v2 handed back with its gate raised at 10:18. */
function handedBack(checks: readonly Check[] = CHECKS): RunLineage {
  return lineage({
    versions: [
      version({
        versionId: 'v-2',
        version: 2,
        runId: null,
        evidence: { digest: 'e2e2e2e2e2e2e2e2', body: staged('Fix the footer') },
        gate: {
          id: 'g-2',
          state: 'pending',
          round: 1,
          expiresAt: '2026-10-01T00:00:00.000Z',
          expired: false,
          payloadDigest: 'd2',
          raisedAt: '2026-09-29T10:18:00.000Z',
        },
        checks,
      }),
      version({
        versionId: 'v-1',
        version: 1,
        supersededAt: '2026-09-29T10:18:00.000Z',
        runStartedAt: '2026-09-29T09:00:00.000Z',
        evidence: { digest: 'e1e1e1e1e1e1e1e1', body: staged('Fix the footer') },
        gate: {
          id: 'g-1',
          state: 'approved',
          round: 0,
          expiresAt: '2026-10-01T00:00:00.000Z',
          expired: false,
          payloadDigest: 'd1',
          raisedAt: '2026-09-29T08:50:00.000Z',
        },
      }),
    ],
    decisions: [
      { decision: 'approved', decidedByPersonId: 'p-ada', decidedAt: '2026-09-29T08:55:00.000Z' },
    ],
  });
}

const NOW = Date.parse('2026-09-29T09:45:00.000Z');

const rowsOf = (page: Mounted): readonly string[] =>
  page.all('[data-agent="activity"] [data-activity-row]').map((row) => row.textContent ?? '');

const cell = (page: Mounted, key: string): string =>
  page.find(`[data-agent="hero"] [data-hero="${key}"]`)?.textContent ?? '';

// eslint-disable-next-line max-lines-per-function -- the hero's cells, each on its own run
describe('MP-6-2 hero stats', () => {
  it('counts the jobs complete, the checks recorded and the time from the run’s start to the gate', async () => {
    const page = await pane({ lineages: [handedBack()], now: NOW });
    expect(cell(page, 'jobs')).toContain('3 / 7');
    expect(cell(page, 'jobs')).toContain('jobs complete');
    expect(cell(page, 'checks')).toContain('5');
    expect(cell(page, 'checks')).toContain('checks recorded');
    expect(cell(page, 'time')).toContain('1h 18m');
    expect(cell(page, 'time')).toContain('to the gate');
  });

  it('reads elapsed while no gate has been raised since the run started', async () => {
    const started = lineage({
      versions: [
        version({
          runStartedAt: '2026-09-29T09:00:00.000Z',
          gate: {
            id: 'g-1',
            state: 'approved',
            round: 0,
            expiresAt: '2026-10-01T00:00:00.000Z',
            expired: false,
            payloadDigest: 'd1',
            raisedAt: '2026-09-29T08:50:00.000Z',
          },
        }),
      ],
      reservations: [running],
    });
    const page = await pane({ lineages: [started], now: NOW });
    expect(cell(page, 'time')).toContain('45m');
    expect(cell(page, 'time')).toContain('elapsed');
  });

  it('omits the time and tokens cells when they are unknown', async () => {
    const page = await pane({ lineages: [lineage()], now: NOW });
    expect(page.find('[data-agent="hero"]')).not.toBeNull();
    expect(page.find('[data-hero="time"]')).toBeNull();
    expect(page.find('[data-hero="tokens"]')).toBeNull();
  });
});

describe('MP-6-2 checks two counts', () => {
  it('prints passed out of recorded, two different counts from two different sets', async () => {
    const page = await pane({ lineages: [handedBack()], now: NOW });
    const line = page.find('[data-agent="artefacts"] [data-artefact-checks]')?.textContent ?? '';
    expect(line).toContain('Checks passed 3 of 5 recorded');
  });

  it('says none were recorded rather than printing a count of nothing twice', async () => {
    const page = await pane({ lineages: [handedBack([])], now: NOW });
    const line = page.find('[data-agent="artefacts"] [data-artefact-checks]')?.textContent ?? '';
    expect(line).toContain('No checks recorded on this version.');
    expect(line).not.toMatch(/0 of 0/u);
  });
});

describe('MP-6-2 supersedes chain', () => {
  it('lists each artefact version newest first with the version it supersedes', async () => {
    const page = await pane({ lineages: [handedBack()], now: NOW });
    const rows = page.all('[data-agent="artefacts"] [data-artefact-version]');
    expect(rows.map((row) => (row as HTMLElement).dataset['artefactVersion'])).toStrictEqual([
      '2',
      '1',
    ]);
    expect(rows[0]?.textContent).toContain('v2 · current');
    expect(rows[0]?.textContent).toContain('supersedes v1');
    expect(rows[0]?.textContent).toContain('e2e2e2e2');
    expect(rows[1]?.textContent).not.toContain('current');
    expect(rows[1]?.textContent).not.toContain('supersedes');
    expect(page.find('[data-agent="artefacts"]')?.textContent).toContain('Fix the footer');
  });

  it('says so when the task has not produced an artefact yet', async () => {
    const page = await pane({ lineages: [lineage()], now: NOW });
    expect(page.find('[data-agent="artefacts"]')?.textContent).toContain(
      'This task has not produced an artefact yet.',
    );
  });
});

// eslint-disable-next-line max-lines-per-function -- the log's order, its growth and its empty state
describe('MP-6-2 log append-only', () => {
  it('draws the run’s stored records oldest first under "append-only evidence"', async () => {
    const page = await pane({ lineages: [handedBack()], now: NOW });
    expect(page.find('[data-agent="activity"]')?.textContent).toContain('append-only evidence');
    const rows = rowsOf(page);
    expect(rows[0]).toContain('Gate raised on v1');
    expect(rows[1]).toContain('approved');
    expect(rows[2]).toContain('Run started on v1');
    expect(rows.at(-1)).toContain('Gate raised on v2');
    expect(rows).toHaveLength(9);
  });

  it('a new record adds a row and leaves every earlier row as it was', async () => {
    const before = rowsOf(await pane({ lineages: [handedBack()], now: NOW }));
    const more = [...CHECKS, check('c6', 'passed', '2026-09-29T10:30:00.000Z')];
    const after = rowsOf(await pane({ lineages: [handedBack(more)], now: NOW }));
    expect(after.slice(0, before.length)).toStrictEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toContain('check c6');
  });

  it('says there is nothing to log before any run', async () => {
    const page = await pane({ lineages: [lineage({ versions: [version({ runId: null })] })] });
    expect(page.find('[data-agent="activity"]')?.textContent).toContain(
      'No run, so there is nothing operational to log yet.',
    );
  });
});

describe('MP-6-2 side column', () => {
  it('puts the granted scope and what the run was given in the side column', async () => {
    const page = await pane({ lineages: [handedBack()], now: NOW });
    const side = page.find('.agentpage aside[data-agent="side"]');
    expect(side).not.toBeNull();
    expect(side?.querySelector('[data-agent="scope"]')).not.toBeNull();
    expect(side?.querySelector('[data-agent="given"]')?.textContent).toContain(
      'Nothing was pinned for this run.',
    );
    expect(page.find('.agentpage__main [data-agent="hero"]')).not.toBeNull();
  });

  it('is 21rem wide at 1279 pixels and above, and stacks below', () => {
    const css = readFileSync(
      new URL('../../packages/ui/src/styles/6-agent.css', import.meta.url),
      'utf8',
    ).replaceAll(/\s+/gu, ' ');
    expect(css).toMatch(
      /@media \(min-width: 1279px\) \{ \.agentpage \{[^}]*grid-template-columns: minmax\(0, 1fr\) 21rem;/u,
    );
    expect(css).toMatch(/\.agentpage \{[^}]*grid-template-columns: minmax\(0, 1fr\);/u);
  });
});

describe('MP-6-2 agent content inert', () => {
  it('draws a planted script or markup in the agent’s writing as text', async () => {
    const planted = '<img src=x onerror="window.owned=1"><script>window.owned=1</script>';
    const plantedIn = (one: RunLineage['versions'][number]): RunLineage['versions'][number] =>
      Object.assign({}, one, { evidence: { digest: 'e0e0e0e0', body: staged(planted) } });
    const base = handedBack([
      check('c1', 'passed', '2026-09-29T09:10:00.000Z', planted),
      { ...check('c2', 'failed', '2026-09-29T09:20:00.000Z'), note: planted },
    ]);
    const page = await pane({
      lineages: [{ ...base, versions: base.versions.map(plantedIn) }],
      now: NOW,
    });
    expect(page.all('img, script, iframe, object')).toHaveLength(0);
    expect(page.find('[data-agent="artefacts"]')?.textContent).toContain(planted);
    expect(page.find('[data-agent="activity"]')?.textContent).toContain(planted);
    expect((globalThis as { owned?: number }).owned).toBeUndefined();
  });
});
