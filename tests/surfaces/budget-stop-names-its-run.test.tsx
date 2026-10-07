// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A budget stop's answers (AW-05, C54) belong to the attempt they are drawn
// on. With two attempts on a task, the run waiting at its ceiling is the
// latest one's: opening the earlier attempt draws no Top up or End for it,
// and wherever the answers are drawn they name the run they act on.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskLedger } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

type Stop = NonNullable<TaskLedger['stops']>[number];

const ask = (overrides: Partial<Stop> = {}): Stop => ({
  askId: 'ask-1',
  runId: 'run-latest',
  number: 1,
  kind: 'stop',
  ceilingMinor: 400,
  spentMinor: 390,
  currency: 'AUD',
  raisedAt: '2026-09-30T01:00:00.000Z',
  answer: null,
  awaitingSecond: null,
  ...overrides,
});

/** An earlier attempt that ran on `run-earlier` and a latest one on `run-latest`. */
function twoAttempts(stops: readonly Stop[]) {
  const onTopUpAtStop = vi.fn();
  const onEndAtStop = vi.fn();
  const earlier = lineage({
    lineageId: 'l-0',
    state: 'rejected',
    versions: [version({ versionId: 'v-0', runId: 'run-earlier' })],
  });
  const latest = lineage({
    lineageId: 'l-1',
    versions: [version({ versionId: 'v-1', runId: 'run-latest' })],
  });
  return {
    onTopUpAtStop,
    onEndAtStop,
    props: {
      lineages: [latest, earlier],
      ledger: { envelopes: [], stops },
      onTopUpAtStop,
      onEndAtStop,
    },
  };
}

const MAIN = '[data-agent="main"]';

describe('a budget stop names the run it acts on', () => {
  it('opening the earlier attempt draws no Top up or End for the latest run', async () => {
    const { props, onTopUpAtStop, onEndAtStop } = twoAttempts([ask()]);
    const page = await pane(props);
    await page.click('[data-attempt="1"]');
    expect(page.find('[data-agent="pane"]')?.getAttribute('data-agent-lineage')).toBe('l-0');
    expect(page.find(`${MAIN} [data-agent="budget-stop"]`)).toBeNull();
    expect(page.find(`${MAIN} [data-stop="top-up"]`)).toBeNull();
    expect(page.find(`${MAIN} [data-stop="end"]`)).toBeNull();
    expect(onTopUpAtStop).not.toHaveBeenCalled();
    expect(onEndAtStop).not.toHaveBeenCalled();
  });

  it('the latest attempt draws its own stop, naming its run in the head and on both answers', async () => {
    const { props, onEndAtStop } = twoAttempts([ask()]);
    const page = await pane(props);
    const stop = page.find(`${MAIN} [data-agent="budget-stop"]`);
    expect(stop?.getAttribute('data-stop-run')).toBe('run-latest');
    expect(stop?.querySelector('[data-stop="run"]')?.textContent).toContain('run-latest');
    expect(stop?.querySelector('[data-stop="top-up"]')?.getAttribute('aria-label')).toContain(
      'run-latest',
    );
    expect(stop?.querySelector('[data-stop="end"]')?.getAttribute('aria-label')).toContain(
      'run-latest',
    );
    await page.click(`${MAIN} [data-stop="end"]`);
    expect(onEndAtStop.mock.calls).toStrictEqual([['run-latest', 'ask-1']]);
  });

  it('an earlier attempt still waiting draws only its own stop, and the latest leaves it out', async () => {
    const { props, onEndAtStop } = twoAttempts([
      ask({ askId: 'ask-earlier', runId: 'run-earlier' }),
      ask({ askId: 'ask-latest', runId: 'run-latest' }),
    ]);
    const page = await pane(props);
    const runs = (): readonly (string | null)[] =>
      page
        .all(`${MAIN} [data-agent="budget-stop"]`)
        .map((each) => each.getAttribute('data-stop-run'));
    expect(runs()).toStrictEqual(['run-latest']);
    await page.click('[data-attempt="1"]');
    expect(runs()).toStrictEqual(['run-earlier']);
    await page.click(`${MAIN} [data-stop="end"]`);
    expect(onEndAtStop.mock.calls).toStrictEqual([['run-earlier', 'ask-earlier']]);
  });
});
