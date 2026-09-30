// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's hero stats on the Agent pane's run summary (the mockup's TA-01,
// `runHero`): jobs complete out of the run's jobs, and the checks recorded,
// derived from `task.read`'s projection as the rest of the summary is. The
// time cell (to the gate, or elapsed) and the tokens cell are omitted while
// the read carries no run times or token units, as the mockup omits them when
// unknown; they are never drawn as zero.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const check = (id: string, outcome: string) => ({
  id,
  name: `check ${id}`,
  outcome,
  note: null,
  performedByActorId: 'actor-agent',
  recordedAt: '2026-09-30T01:00:00.000Z',
});

const stat = (page: Awaited<ReturnType<typeof pane>>, key: string) => ({
  n: page.find(`[data-agent="summary"] [data-hero="${key}"] .tph__n`)?.textContent ?? null,
  k: page.find(`[data-agent="summary"] [data-hero="${key}"] .tf__k`)?.textContent ?? null,
});

describe('MP-6-2 hero stats', () => {
  it('MP-6-2 hero stats: jobs complete out of the run’s jobs, and the checks recorded', async () => {
    const page = await pane({
      lineages: [
        lineage({ versions: [version({ checks: [check('a', 'passed'), check('b', 'failed')] })] }),
      ],
    });
    // The work (waiting at the gate), two checks (one passed) and the gate itself.
    expect(stat(page, 'jobs')).toStrictEqual({ n: '1 / 4', k: 'jobs complete' });
    expect(stat(page, 'checks')).toStrictEqual({ n: '2', k: 'checks recorded' });
  });

  it('MP-6-2 hero stats: no check is a count of none, and the time and tokens cells are left out while unknown', async () => {
    const page = await pane({ lineages: [lineage()] });
    expect(stat(page, 'checks')).toStrictEqual({ n: '0', k: 'checks recorded' });
    expect(page.find('[data-hero="time"]')).toBeNull();
    expect(page.find('[data-hero="tokens"]')).toBeNull();
    expect(page.all('[data-agent="summary"] .tph__stat')).toHaveLength(2);
  });
});

const timed = (startedAt: string | null, endedAt: string | null) =>
  pane({ lineages: [lineage({ versions: [version({ startedAt, endedAt })] })] });

describe('MP-6-2 hero stats, the time cell', () => {
  it('MP-6-2 hero stats: a run handed back shows the time it took, in hours and minutes', async () => {
    const page = await timed('2026-09-30T01:00:00.000Z', '2026-09-30T02:18:10.000Z');
    expect(stat(page, 'time')).toStrictEqual({ n: '1h 18m', k: 'elapsed' });
  });

  it('MP-6-2 hero stats: under an hour is minutes, and never less than one', async () => {
    expect(
      stat(await timed('2026-09-30T01:00:00.000Z', '2026-09-30T01:42:00.000Z'), 'time'),
    ).toStrictEqual({
      n: '42m',
      k: 'elapsed',
    });
    expect(
      stat(await timed('2026-09-30T01:00:00.000Z', '2026-09-30T01:00:05.000Z'), 'time').n,
    ).toBe('1m');
  });

  it('MP-6-2 hero stats: a run still out, or never started, has no time cell', async () => {
    expect((await timed('2026-09-30T01:00:00.000Z', null)).find('[data-hero="time"]')).toBeNull();
    expect((await timed(null, null)).find('[data-hero="time"]')).toBeNull();
  });
});

const spent = (tokenUnits: number | null) =>
  pane({ lineages: [lineage({ versions: [version({ tokenUnits })] })] });

describe('MP-6-2 hero stats, the tokens cell', () => {
  it('MP-6-2 hero stats: the run’s token units, in thousands from a thousand', async () => {
    expect(stat(await spent(122_400), 'tokens')).toStrictEqual({ n: '122k', k: 'tokens spent' });
    expect(stat(await spent(840), 'tokens')).toStrictEqual({ n: '840', k: 'tokens spent' });
  });

  it('MP-6-2 hero stats: a run with no recorded units has no tokens cell, never a zero', async () => {
    expect((await spent(null)).find('[data-hero="tokens"]')).toBeNull();
  });
});
