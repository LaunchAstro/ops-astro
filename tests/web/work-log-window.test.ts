// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log window's rules without React: a refresh reads every loaded
// page and stops at the first failure, and an earlier page joins only the
// window it left from.

import { describe, expect, it } from 'vitest';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  extend,
  joins,
  readWindow,
  type LedgerRead,
} from '../../apps/web/src/screens/projects/work-log-window.ts';
import { FIRST, SECOND, SECOND_OF_THREE, THIRD, json, refused } from './work-log-stand-in.tsx';

function ledger(answers: Record<string, Response>) {
  const asked: (string | null)[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (_, init) => {
      const { before } = JSON.parse(String(init?.body)) as { before: string | null };
      asked.push(before);
      return Promise.resolve(answers[String(before)]!.clone());
    },
  });
  return { client, asked };
}

const windowOf = (ledgerResult: TaskLedgerResult, zone = 'UTC'): LedgerRead => ({
  zone,
  query: null,
  ledger: ledgerResult,
});

describe('reading the window', () => {
  it('reads the first page alone when nothing earlier is loaded', async () => {
    const { client, asked } = ledger({ null: json(FIRST) });
    expect(await readWindow(client, 'UTC', null, null)).toEqual({
      ok: true,
      value: windowOf(FIRST),
    });
    expect(asked).toEqual([null]);
  });

  it('reads every page down to the oldest day loaded, as one answer', async () => {
    const { client, asked } = ledger({
      null: json(FIRST),
      '2026-09-22': json(SECOND_OF_THREE),
      '2026-09-15': json(THIRD),
    });
    const read = await readWindow(client, 'UTC', null, '2026-09-08');
    expect(asked).toEqual([null, '2026-09-22', '2026-09-15']);
    expect(read).toEqual({
      ok: true,
      value: windowOf({
        ...FIRST,
        days: [...FIRST.days, ...SECOND.days, ...THIRD.days],
        earlier: false,
      }),
    });
  });

  it('stops at the first refused page and answers its refusal', async () => {
    const { client, asked } = ledger({
      null: json(FIRST),
      '2026-09-22': json(refused('SCOPE_NOT_GRANTED', ['task']), 403),
    });
    const read = await readWindow(client, 'UTC', null, '2026-09-08');
    expect(asked).toEqual([null, '2026-09-22']);
    expect(read).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  });
});

describe('an earlier page joining the window', () => {
  const drawn = windowOf(FIRST);
  const asking = { epoch: 3, zone: 'UTC', boundary: '2026-09-22' };

  it('joins the window it left from, below its days', () => {
    expect(joins(asking, 3, drawn)).toBe(true);
    expect(extend(drawn, SECOND).ledger.days.map((each) => each.day)).toEqual([
      '2026-09-28',
      '2026-09-22',
      '2026-09-15',
    ]);
  });

  it('is dropped by a later epoch, another zone or another last day', () => {
    expect(joins(asking, 4, drawn)).toBe(false);
    expect(joins(asking, 3, windowOf(FIRST, 'Australia/Brisbane'))).toBe(false);
    expect(joins(asking, 3, extend(drawn, SECOND))).toBe(false);
  });
});
