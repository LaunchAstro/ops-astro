// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-5's stop states on the token panel: AW-05's stops as `task.read`'s
// ledger carries them (`tests/api/mp-6-5-stops.test.ts` proves the read
// against Postgres). The panel shows each stopped run's latest ask and writes
// nothing; answering it is C54's (`c54-budget-stop.test.tsx`).
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, exactly as it was first written red */

import { afterEach, describe, expect, it } from 'vitest';
import type { TaskLedger } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

type Stop = NonNullable<TaskLedger['stops']>[number];

const ENVELOPE: TaskLedger['envelopes'][number] = {
  id: 'env-1',
  state: 'open',
  maximumMinor: 5_000,
  heldMinor: 400,
  actualMinor: 1_200,
  currency: 'AUD',
  openedAt: '2026-09-29T01:00:00.000Z',
  closedAt: null,
  openedBy: { versionId: 'v-1' },
  cap: { key: 'agent_work', limitMinor: 100_000, currency: 'AUD' },
};

const ask = (overrides: Partial<Stop> = {}): Stop => ({
  askId: 'ask-1',
  runId: 'run-2',
  number: 1,
  kind: 'stop',
  ceilingMinor: 400,
  spentMinor: 380,
  currency: 'AUD',
  raisedAt: '2026-09-30T01:00:00.000Z',
  answer: null,
  awaitingSecond: null,
  ...overrides,
});

/** One task, one envelope, and the stops the read carries (none on an older read). */
const stopsWorld = (stops?: readonly Stop[]) => ({
  ledger: stops === undefined ? { envelopes: [ENVELOPE] } : { envelopes: [ENVELOPE], stops },
  lineages: [lineage()],
});

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

// eslint-disable-next-line max-lines-per-function -- one panel, each stop state on it
describe('MP-6-5 stop states', () => {
  it('MP-6-5 stop states: the stop and its top-up request, counted against three', async () => {
    const page = await pane(stopsWorld([ask()]));
    const stop = page.find('[data-agent="tokens"] [data-tokens="stop"]');
    expect(stop?.getAttribute('data-stop-run')).toBe('run-2');
    expect(stop?.getAttribute('data-stop-kind')).toBe('stop');
    expect(text(stop)).toContain('Stopped at its approved ceiling');
    expect(text(stop)).toContain('AUD 3.80 of AUD 4.00');
    expect(text(page.find('[data-tokens="stop-count"]'))).toBe('Stop 1 of 3');
    expect(text(page.find('[data-tokens="top-up-request"]'))).toContain(
      'asks a person to top it up or end the work',
    );
    // The panel only shows the stop: answering it is C54's, below the panel.
    expect(page.all('[data-agent="tokens"] button:not([data-tokens="skill"])')).toHaveLength(0);
    expect(page.all('[data-agent="tokens"] input')).toHaveLength(0);
  });

  it('MP-6-5 stop states: the latest ask per run is the one shown, and an answered one says how', async () => {
    const page = await pane(
      stopsWorld([
        ask({ askId: 'ask-1', answer: 'top_up' }),
        ask({ askId: 'ask-2', number: 2, spentMinor: 400 }),
        ask({ askId: 'ask-9', runId: 'run-1', answer: 'end' }),
      ]),
    );
    const stops = page.all('[data-tokens="stop"]');
    expect(stops.map((stop) => stop.getAttribute('data-stop-run'))).toStrictEqual([
      'run-2',
      'run-1',
    ]);
    expect(text(stops[0]?.querySelector('[data-tokens="stop-count"]'))).toBe('Stop 2 of 3');
    expect(stops[0]?.getAttribute('data-stop-answer')).toBe('waiting');
    expect(stops[1]?.getAttribute('data-stop-answer')).toBe('end');
    expect(text(stops[1])).toContain('A person ended the work at this stop');
    expect(stops[1]?.querySelector('[data-tokens="top-up-request"]')).toBeNull();
    const topped = await pane(stopsWorld([ask({ answer: 'top_up' })]));
    expect(text(topped.find('[data-tokens="stop"]'))).toContain('A person topped it up');
  });

  it('MP-6-5 stop states: after the third stop the one consolidated decision is shown', async () => {
    const page = await pane(
      stopsWorld([
        ask({ askId: 'ask-1', answer: 'top_up' }),
        ask({ askId: 'ask-2', number: 2, answer: 'top_up' }),
        ask({ askId: 'ask-3', number: 3, kind: 'consolidated', ceilingMinor: 500 }),
      ]),
    );
    const stop = page.find('[data-tokens="stop"]');
    expect(stop?.getAttribute('data-stop-kind')).toBe('consolidated');
    expect(text(page.find('[data-tokens="stop-count"]'))).toBe('Stop 3 of 3');
    expect(text(page.find('[data-tokens="consolidated"]'))).toContain(
      'one consolidated decision: top it up once more or end the work. It will not stop again to ask',
    );
  });

  it('MP-6-5 stop states: a top-up above the band says it waits for a second person', async () => {
    const page = await pane(stopsWorld([ask({ awaitingSecond: { amountMinor: 60_000 } })]));
    expect(text(page.find('[data-tokens="awaiting-second"]'))).toContain(
      'A top-up of AUD 600.00 waits for a second person',
    );
  });

  it('MP-6-5 stop states: no stop draws nothing, and an older read without stops is the same', async () => {
    expect((await pane(stopsWorld([]))).find('[data-tokens="stop"]')).toBeNull();
    expect((await pane(stopsWorld())).find('[data-tokens="stop"]')).toBeNull();
  });
});
