// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's "Checks passed" (TA-05, MP-6-2.md:49): two different counts, the
// checks that passed out of the checks the run recorded, never one count
// twice (the mockup's row draws the recorded count on both sides). The counts
// are the run's own checks (run_checks, as `task.read` carries them): a
// failed or inconclusive check is recorded and not passed. The artefact rows
// of the same section wait on an artefact store.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import type { RunCheck } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const check = (id: string, outcome: string): RunCheck => ({
  id,
  name: `check ${id}`,
  outcome,
  note: null,
  performedByActorId: 'agent-1',
  recordedAt: '2026-09-30T10:00:00.000Z',
});

const withChecks = async (checks: readonly RunCheck[]) =>
  await pane({ lineages: [lineage({ versions: [version({ checks })] })] });

const counts = (page: Awaited<ReturnType<typeof withChecks>>) => ({
  passed: page.find('[data-evidence="passed"]')?.textContent,
  recorded: page.find('[data-evidence="recorded"]')?.textContent,
});

describe('MP-6-2 checks two counts', () => {
  it('MP-6-2 checks two counts: passed out of recorded, a failed or inconclusive check recorded and not passed', async () => {
    const page = await withChecks([
      check('1', 'passed'),
      check('2', 'failed'),
      check('3', 'passed'),
      check('4', 'inconclusive'),
    ]);
    const row = page.find('[data-agent="evidence"] [data-evidence="checks"]');
    expect(row?.querySelector('.tf__k')?.textContent).toBe('Checks passed');
    expect(counts(page)).toStrictEqual({ passed: '2', recorded: 'of 4 recorded' });
  });

  it('MP-6-2 checks two counts: none passed reads zero of the recorded, never the recorded twice', async () => {
    const page = await withChecks([check('1', 'failed'), check('2', 'inconclusive')]);
    expect(counts(page)).toStrictEqual({ passed: '0', recorded: 'of 2 recorded' });
  });

  it('MP-6-2 checks two counts: a run with no checks has no counts row', async () => {
    const page = await withChecks([]);
    expect(page.find('[data-agent="evidence"]')?.textContent).toContain('No checks recorded yet.');
    expect(page.find('[data-evidence="checks"]')).toBeNull();
  });

  it('MP-6-2 checks two counts: the section sits in the main column after the gate', async () => {
    const page = await withChecks([check('1', 'passed')]);
    const gate = page.find('[data-agent="main"] [data-agent="gate"]');
    const section = page.find('[data-agent="main"] [data-agent="evidence"]');
    expect(section?.querySelector('.sb__k')?.textContent).toBe('Artefacts and evidence');
    const order = gate?.compareDocumentPosition(section as Node) ?? 0;
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
