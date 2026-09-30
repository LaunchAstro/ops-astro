// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C54's answers at a budget stop on the Agent pane (AW-05): a top-up through
// `run.top_up` or the end through `run.end_at_budget_stop`, naming the task
// and the run the read showed, then a reread. The HTTP boundary is stood in
// (`c54-page.tsx`); the read and the answers against Postgres are
// `tests/api/mp-6-5-stops.test.ts`, and each command under its locks is AW-05's
// own suites'.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { describe, expect, it } from 'vitest';
import { IN_PANE, TASK_ID, open, press, type, type World } from './c54-page.tsx';

const RUN_ID = '88888888-8888-4888-8888-888888888888';

/** A run stopped at its ceiling for the `number`th time, its latest ask unanswered. */
function stoppedAt(number: number, answer?: World['answer']): World {
  const asks = Array.from({ length: number }, (_, index) => ({
    askId: `ask-${String(index + 1)}`,
    runId: RUN_ID,
    number: index + 1,
    kind: index === 2 ? 'consolidated' : 'stop',
    ceilingMinor: 400,
    spentMinor: 390,
    currency: 'AUD',
    raisedAt: '2026-09-30T01:00:00.000Z',
    answer: index + 1 < number ? 'top_up' : null,
    awaitingSecond: null,
  }));
  return { attemptState: 'settled', answer: answer ?? { detail: {} }, stops: asks };
}

// eslint-disable-next-line max-lines-per-function -- one page, each answer at the stop on it
describe('C54 the answers at the budget stop on the Agent pane', () => {
  it('C54 consolidated stop answered: ending the work sends run.end_at_budget_stop for the run, then reads again', async () => {
    const { page, sent, reads } = await open(stoppedAt(3));
    expect(page.find(`${IN_PANE} [data-agent="budget-stop"]`)?.getAttribute('data-stop-kind')).toBe(
      'consolidated',
    );
    const before = reads();
    await press(page, '[data-stop="end"]');
    expect(sent).toStrictEqual([
      {
        route: 'run/end_at_budget_stop',
        body: { operationId: 'operation-54', recordId: TASK_ID, runId: RUN_ID },
      },
    ]);
    expect(reads()).toBeGreaterThan(before);
  });

  it('C54 consolidated stop answered: a top-up sends the amount in the ask’s currency, then reads again', async () => {
    const { page, sent, reads } = await open(stoppedAt(3));
    const before = reads();
    await type(page, '[data-stop="amount"]', '2.50');
    await press(page, '[data-stop="top-up"]');
    expect(sent).toStrictEqual([
      {
        route: 'run/top_up',
        body: {
          operationId: 'operation-54',
          recordId: TASK_ID,
          runId: RUN_ID,
          amountMinor: 250,
          currency: 'AUD',
        },
      },
    ]);
    expect(reads()).toBeGreaterThan(before);
  });

  it('C54 consolidated stop answered: no amount, or not a figure above nothing, sends no top-up', async () => {
    const { page, sent } = await open(stoppedAt(3));
    const topUp = (): HTMLButtonElement | null =>
      page.find(`${IN_PANE} [data-stop="top-up"]`) as HTMLButtonElement | null;
    expect(topUp()?.disabled).toBe(true);
    for (const amount of ['0', '-3', '1e3', '2.505', ' ']) {
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await type(page, '[data-stop="amount"]', amount);
      expect(topUp()?.disabled, amount).toBe(true);
    }
    expect(sent).toStrictEqual([]);
  });

  it('C54 consolidated stop answered: the first stop is answered the same way, and says its count', async () => {
    const { page, sent } = await open(stoppedAt(1));
    const stop = page.find(`${IN_PANE} [data-agent="budget-stop"]`);
    expect(stop?.getAttribute('data-stop-kind')).toBe('stop');
    expect(stop?.textContent).toContain('Stop 1 of 3');
    await press(page, '[data-stop="end"]');
    expect(sent.map((call) => call.route)).toStrictEqual(['run/end_at_budget_stop']);
  });

  it('C54 consolidated stop answered: an answered stop draws no controls', async () => {
    const answered = stoppedAt(3);
    const stops = (answered.stops ?? []).map((ask) => Object.assign({}, ask, { answer: 'end' }));
    const { page } = await open({ ...answered, stops });
    expect(page.find(`${IN_PANE} [data-agent="budget-stop"]`)).toBeNull();
  });

  it('C54 top-up approver: above the band the pane says a second person approves it too', async () => {
    const { page } = await open(stoppedAt(3, { detail: { state: 'awaiting_second' } }));
    await type(page, '[data-stop="amount"]', '600');
    await press(page, '[data-stop="top-up"]');
    expect(page.find(`${IN_PANE} [data-stop="awaiting"]`)?.textContent).toContain(
      'a second person approves the same amount',
    );
  });

  it('C54 refusal billing:decide: a refused answer at the stop is said in words, and the stop stays', async () => {
    const { page, sent } = await open(stoppedAt(3, { refuse: 'SCOPE_NOT_GRANTED' }));
    await type(page, '[data-stop="amount"]', '5');
    await press(page, '[data-stop="top-up"]');
    expect(sent.map((call) => call.route)).toStrictEqual(['run/top_up']);
    expect(page.find(`${IN_PANE} [role="alert"]`)?.textContent ?? '').not.toBe('');
    expect(page.find(`${IN_PANE} [data-agent="budget-stop"]`)).not.toBeNull();
  });
});
