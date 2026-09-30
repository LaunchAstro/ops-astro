// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C54 on the Agent pane: its controls call `budget.record_outcome` (T3d1) and
// `budget.write_off` (T3c) through the page's real client, naming the task and
// the attempt the read showed, then read again. The HTTP boundary is stood in;
// what each command does under its locks is proven against Postgres by its
// own suites (`tests/runtime/t3d1-*`, `t3c-write-off*`).

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { ATTEMPT_ID, IN_PANE, TASK_ID, open, pause, press, type, type World } from './c54-page.tsx';

const UNKNOWN: World = { attemptState: 'liability_unknown', answer: { detail: {} } };

describe('C54 the three outcomes on the Agent pane', () => {
  for (const [name, outcome] of [
    ['C54 nothing happened resumes', 'nothing_happened'],
    ['C54 happened finishes', 'happened'],
    ['C54 happened differently reopens', 'happened_differently'],
  ] as const) {
    it(`${name}: the pane records ${outcome} for the unknown attempt, then reads again`, async () => {
      const { page, sent, reads } = await open(UNKNOWN);
      const before = reads();
      await press(page, `[data-outcome="${outcome}"]`);
      expect(sent).toStrictEqual([
        {
          route: 'budget/record_outcome',
          body: { operationId: 'operation-54', recordId: TASK_ID, attemptId: ATTEMPT_ID, outcome },
        },
      ]);
      expect(reads()).toBeGreaterThan(before);
    });
  }

  it('C54 unknown keeps its stop: exactly three outcomes, never a fourth, and the stop stays said', async () => {
    const { page, sent } = await open(UNKNOWN);
    expect(
      page.all(`${IN_PANE} [data-outcome]`).map((button) => button.getAttribute('data-outcome')),
    ).toStrictEqual(['nothing_happened', 'happened', 'happened_differently']);
    expect(page.find(`${IN_PANE} [data-agent="unknown"]`)?.textContent).toContain(
      'stays stopped until a person says what happened',
    );
    expect(sent).toStrictEqual([]);
  });

  it('C54 unknown keeps its stop: an attempt whose effect is known draws no outcome and no write-off', async () => {
    const { page } = await open({ attemptState: 'settled', answer: { detail: {} } });
    expect(page.find(`${IN_PANE} [data-agent="pane"]`)).not.toBeNull();
    expect(page.all(`${IN_PANE} [data-outcome]`)).toHaveLength(0);
    expect(page.find(`${IN_PANE} [data-agent="write-off"]`)).toBeNull();
  });
});

// eslint-disable-next-line max-lines-per-function -- one page, each write-off case on it
describe('C54 the write-off on the Agent pane', () => {
  it('C54 write-off amount and reason: sends the amount to charge and the written reason, then reads again', async () => {
    const { page, sent, reads } = await open(UNKNOWN);
    const before = reads();
    await type(page, '[data-write-off="amount"]', '12.50');
    await type(page, '[data-write-off="reason"]', 'The reply went out once; the log shows it.');
    await press(page, '[data-write-off="submit"]');
    expect(sent).toStrictEqual([
      {
        route: 'budget/write_off',
        body: {
          operationId: 'operation-54',
          recordId: TASK_ID,
          attemptId: ATTEMPT_ID,
          amountMinor: 1_250,
          reason: 'The reply went out once; the log shows it.',
        },
      },
    ]);
    expect(reads()).toBeGreaterThan(before);
  });

  it('C54 write-off amount and reason: the amount starts at the reserved maximum, and nothing is a figure too', async () => {
    const { page, sent } = await open(UNKNOWN);
    const amount = page.find(`${IN_PANE} [data-write-off="amount"]`) as HTMLInputElement | null;
    expect(amount?.value).toBe('18.00');
    await type(page, '[data-write-off="amount"]', '0');
    await type(page, '[data-write-off="reason"]', 'Nothing was charged by the provider.');
    await press(page, '[data-write-off="submit"]');
    expect(sent.map((call) => call.body['amountMinor'])).toStrictEqual([0]);
  });

  it('C54 write-off amount and reason: no reason, or no amount, sends nothing', async () => {
    const { page, sent } = await open(UNKNOWN);
    const submit = (): HTMLButtonElement | null =>
      page.find(`${IN_PANE} [data-write-off="submit"]`) as HTMLButtonElement | null;
    expect(submit()?.disabled).toBe(true);
    await type(page, '[data-write-off="reason"]', 'A reason with no amount.');
    await type(page, '[data-write-off="amount"]', '');
    expect(submit()?.disabled).toBe(true);
    await type(page, '[data-write-off="reason"]', '   ');
    await type(page, '[data-write-off="amount"]', '3.00');
    expect(submit()?.disabled).toBe(true);
    await act(async () => {
      submit()?.click();
      await pause();
    });
    expect(sent).toStrictEqual([]);
  });

  it('C54 write-off amount and reason: above the band, the pane says a second approver is needed', async () => {
    const { page } = await open({
      attemptState: 'liability_unknown',
      answer: { detail: { state: 'awaiting_second_approver' } },
    });
    await type(page, '[data-write-off="reason"]', 'The provider billed the full amount.');
    await press(page, '[data-write-off="submit"]');
    expect(page.find(`${IN_PANE} [data-write-off="awaiting"]`)?.textContent).toContain(
      'a second person approves it too',
    );
  });
});

describe('C54 refusals on the Agent pane', () => {
  it('C54 refusal billing:decide: a person without it is told in words, and the stop stays', async () => {
    const { page, sent } = await open({
      attemptState: 'liability_unknown',
      answer: { refuse: 'SCOPE_NOT_GRANTED' },
    });
    await press(page, '[data-outcome="happened"]');
    expect(sent.map((call) => call.route)).toStrictEqual(['budget/record_outcome']);
    expect(page.find(`${IN_PANE} [role="alert"]`)?.textContent ?? '').not.toBe('');
    expect(page.all(`${IN_PANE} [data-outcome]`)).toHaveLength(3);
  });

  it.todo('C54 an unknown broker effect’s three outcomes (LEANS-ON AW-10)');
});
