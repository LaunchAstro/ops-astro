// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2, "What it knows so far" (TA-04, CS-16.4) over lineages shaped exactly
// as `task.read` returns them: the run's newest state revision, "state vN",
// its last contributing step, what is currently valid, the outstanding
// unknowns (always shown, empty included) and any stale inputs, each drawn as
// text. The write and its authority are proven against Postgres in
// `tests/api/mp-6-2-state-revised.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import type { RunRevision } from '../../packages/ui/src/index.ts';
import { lineage, pane, running, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

type Revision = RunRevision;

const revision = (n: number, overrides: Partial<Revision> = {}): Revision => ({
  id: `rev-${String(n)}`,
  version: n,
  step: `step ${String(n)}`,
  valid: [{ k: 'Live opening', v: `about the practice, revision ${String(n)}` }],
  unknowns: [`whether the form loses the reader, revision ${String(n)}`],
  stale: [],
  revisedByActorId: 'agent-1',
  revisedAt: `2026-09-29T09:${String(10 + n)}:00.000Z`,
  ...overrides,
});

const knows = async (revisions: readonly Revision[], runId: string | null = 'run-1') => {
  const page = await pane({
    lineages: [lineage({ versions: [version({ runId, revisions })], reservations: [running] })],
  });
  return page.find('[data-agent="knows"]');
};

// eslint-disable-next-line max-lines-per-function -- the section's cases, each on its own lineage
describe('MP-6-2 revisions', () => {
  it('shows the newest revision as the run’s current knowledge, "state vN"', async () => {
    const section = await knows([
      revision(1),
      revision(2, {
        step: 'checked the claims',
        valid: [
          { k: 'Live opening', v: 'about the practice' },
          { k: 'Compliance', v: 'no superlative used' },
        ],
        stale: [{ k: 'Hours', why: 'changed since the brief' }],
      }),
    ]);
    expect(section?.textContent).toContain('state v2');
    expect(section?.querySelector('[data-knows="step"]')?.textContent).toContain(
      'checked the claims',
    );
    const valid = [...(section?.querySelectorAll('[data-knows="valid"] li') ?? [])];
    expect(valid.map((row) => row.textContent)).toStrictEqual([
      'Live opening: about the practice',
      'Compliance: no superlative used',
    ]);
    expect(valid[0]?.querySelector('strong')?.textContent).toBe('Live opening');
    expect(section?.querySelector('[data-knows="stale"]')?.textContent).toContain(
      'Hours: changed since the brief',
    );
    expect(section?.textContent).not.toContain('revision 1');
  });

  it('always shows the unknowns, and says what an empty list claims', async () => {
    const section = await knows([revision(1, { unknowns: [], valid: [] })]);
    expect(section?.querySelector('[data-knows="valid"]')?.textContent).toContain(
      'Nothing established yet.',
    );
    expect(section?.querySelector('[data-knows="unknowns"]')?.textContent).toContain(
      'None recorded, and a run that records none is claiming certainty it may not have.',
    );
    expect(section?.querySelector('[data-knows="stale"]')).toBeNull();
  });

  it('a run that has revised nothing says so', async () => {
    const section = await knows([]);
    expect(section?.textContent).toContain('This run has not recorded anything it knows yet.');
    expect(section?.textContent).not.toContain('state v');
  });

  it('a finished run’s knowledge stays shown after its successor version is proposed', async () => {
    const page = await pane({
      lineages: [
        lineage({
          versions: [
            version({ versionId: 'v-2', version: 2, runId: null }),
            version({
              versionId: 'v-1',
              version: 1,
              supersededAt: '2026-09-29T10:18:00.000Z',
              revisions: [revision(1), revision(2), revision(3)],
            }),
          ],
        }),
      ],
    });
    expect(page.find('[data-agent="knows"]')?.textContent).toContain('state v3');
  });

  it('the log lists each revision once, oldest first', async () => {
    const page = await pane({
      lineages: [
        lineage({
          versions: [version({ revisions: [revision(1), revision(2)] })],
          reservations: [running],
        }),
      ],
    });
    const rows = [...page.all('[data-activity-row]')].map((row) => row.textContent ?? '');
    const revised = rows.filter((row) => row.includes('State v'));
    expect(revised).toHaveLength(2);
    expect(revised[0]).toContain('State v1 revised');
    expect(revised[1]).toContain('State v2 revised');
  });
});

describe('MP-6-2 agent content inert', () => {
  it('draws planted markup in the run’s knowledge as text', async () => {
    const planted = '<img src=x onerror="window.owned=1"><script>window.owned=1</script>';
    const section = await knows([
      revision(1, {
        step: planted,
        valid: [{ k: planted, v: planted }],
        unknowns: [planted],
        stale: [{ k: planted, why: planted }],
      }),
    ]);
    expect(section?.querySelectorAll('img, script, iframe, object')).toHaveLength(0);
    expect(section?.textContent).toContain(planted);
    expect((globalThis as { owned?: number }).owned).toBeUndefined();
  });
});
