// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's operational log (TA-06, "append-only evidence"): one row per event
// the run recorded, in the record's own order, each naming the bound plan's
// job its run was proposed under (AW-04's plan record, as `task.execution`'s
// graph carries it), the event in words and its time. The log only grows: a
// later read adds rows after the ones already drawn and rewrites none of them.
// The rows come from `run_events`, which the application may insert and read
// and never change; the pane draws them as stored.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const STEPS = [
  { key: 'draft', title: 'Draft the reply', after: [], runIds: ['run-1'] },
  { key: 'send', title: 'Send it to the client', after: ['draft'], runIds: ['run-2'] },
];

const event = (position: number, runId: string, kind: string, at: string) => ({
  eventId: `e-${String(position)}`,
  runId,
  position,
  kind,
  attemptId: `a-${String(position)}`,
  at,
});

const FIRST = event(1, 'run-1', 'claimed', '2026-09-30T10:00:00.000Z');
const SECOND = event(2, 'run-1', 'handed_back', '2026-09-30T10:42:00.000Z');
const THIRD = event(3, 'run-2', 'claimed', '2026-09-30T11:05:00.000Z');

const logOf = async (events: readonly ReturnType<typeof event>[], steps = STEPS) =>
  await pane({ lineages: [lineage()], activity: { steps, events } });

const rows = (page: Awaited<ReturnType<typeof pane>>) => [
  ...(page.find('[data-agent="log"]')?.querySelectorAll('[data-log="row"]') ?? []),
];

// eslint-disable-next-line max-lines-per-function -- one log, each shape of it
describe('MP-6-2 log append-only', () => {
  it('MP-6-2 log append-only: each recorded event is a row in the record order, with its job, word and time', async () => {
    // Handed over out of order: the log draws the record's order, not arrival.
    const page = await logOf([SECOND, FIRST]);
    const section = page.find('[data-agent="main"] [data-agent="log"]');
    expect(section?.querySelector('.sb__k')?.textContent).toBe('Operational activity');
    expect(section?.textContent).toContain('append-only evidence');
    const drawn = rows(page);
    expect(drawn.map((row) => row.getAttribute('data-log-event'))).toStrictEqual(['e-1', 'e-2']);
    expect(drawn[0]?.querySelector('[data-log="job"]')?.textContent).toBe('JOB-01');
    expect(drawn[0]?.textContent).toContain('claimed');
    expect(drawn[0]?.textContent).toContain('2026-09-30 10:00');
    expect(drawn[0]?.querySelector('[data-log="title"]')?.textContent).toBe('Draft the reply');
    expect(drawn[1]?.textContent).toContain('handed back');
  });

  it('MP-6-2 log append-only: a later read adds rows after the drawn ones and rewrites none of them', async () => {
    const before = rows(await logOf([FIRST, SECOND])).map((row) => row.outerHTML);
    await unmountAll();
    const after = rows(await logOf([FIRST, SECOND, THIRD])).map((row) => row.outerHTML);
    expect(after.slice(0, before.length)).toStrictEqual(before);
    expect(after).toHaveLength(3);
    expect(after[2]).toContain('JOB-02');
    expect(after[2]).toContain('Send it to the client');
  });

  it('MP-6-2 log append-only: a run under no step of the bound plan is logged as outside the plan', async () => {
    const page = await logOf([event(1, 'run-9', 'claimed', '2026-09-30T10:00:00.000Z')]);
    const row = rows(page)[0];
    expect(row?.querySelector('[data-log="job"]')?.textContent).toBe('Outside the plan');
    expect(row?.querySelector('[data-log="title"]')).toBeNull();
  });

  it('MP-6-2 log append-only: no run, and a run with no event, each say so', async () => {
    const none = await pane({
      lineages: [lineage({ versions: [version({ runId: null })] })],
      activity: { steps: [], events: [] },
    });
    expect(none.find('[data-agent="log"]')?.textContent).toContain(
      'No run, so there is nothing operational to log yet.',
    );
    await unmountAll();
    const quiet = await logOf([]);
    expect(quiet.find('[data-agent="log"]')?.textContent).toContain(
      'This run has recorded no steps.',
    );
    expect(rows(quiet)).toHaveLength(0);
  });

  it('MP-6-2 log append-only: no log section where the host passes no activity', async () => {
    const page = await pane({ lineages: [lineage()] });
    expect(page.find('[data-agent="log"]')).toBeNull();
  });

  it('MP-6-2 agent content inert: a step title with markup renders as text', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const page = await logOf([FIRST], [{ ...STEPS[0], title: hostile } as (typeof STEPS)[0]]);
    const row = rows(page)[0];
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.querySelector('[data-log="title"]')?.textContent).toBe(hostile);
  });
});
