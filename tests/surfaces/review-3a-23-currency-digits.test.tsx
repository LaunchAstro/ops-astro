// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-23: the Agent pane's money assumes two minor digits
// (`packages/ui/src/surfaces/agent/format.ts`, money and minorOf). The server
// takes any three-letter currency and counts its minor units by the
// currency's own digits (core-runtime `four-eyes.ts` minorDigits: JPY 0). So a
// JPY allowance of 5000 minor units is five thousand yen, and a person who
// types 5000 at a JPY stop means five thousand yen, 5000 minor units.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { afterEach, describe, expect, it } from 'vitest';
import type { TaskLedger } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';
import { RUN_ID, open, press, type } from './c54-page.tsx';

afterEach(unmountAll);

type Envelope = TaskLedger['envelopes'][number];

const JPY_ENVELOPE: Envelope = {
  id: 'env-jpy',
  state: 'open',
  maximumMinor: 5_000,
  heldMinor: 0,
  actualMinor: 0,
  currency: 'JPY',
  openedAt: '2026-09-29T01:00:00.000Z',
  closedAt: null,
  openedBy: { versionId: 'v-1' },
  cap: { key: 'agent_work', limitMinor: 100_000, currency: 'JPY' },
};

describe('REVIEW-3A-23 money in a currency without two minor digits', () => {
  it('REVIEW-3A-23: a JPY allowance of 5000 minor units shows five thousand yen, not JPY 50.00', async () => {
    const page = await pane({
      ledger: { envelopes: [JPY_ENVELOPE] },
      lineages: [lineage({ versions: [version({ currency: 'JPY' })], reservations: [] })],
    });
    const allowance = page.find('[data-tokens="allowance"]')?.textContent ?? '';
    expect(allowance, 'allowance shown as if JPY had two minor digits').not.toContain('50.00');
    // "JPY 5000", "JPY 5,000" or "¥5,000", and no fractional yen.
    expect(allowance).toMatch(/(?:JPY|¥)\s?5,?000(?![.\d])/u);
  });

  it('REVIEW-3A-23: typing 5000 at a JPY stop sends amountMinor 5000, not 500000', async () => {
    const { page, sent } = await open({
      attemptState: 'settled',
      answer: { detail: {} },
      stops: [
        {
          askId: 'ask-1',
          runId: RUN_ID,
          number: 1,
          kind: 'stop',
          ceilingMinor: 4_000,
          spentMinor: 3_900,
          currency: 'JPY',
          raisedAt: '2026-09-30T01:00:00.000Z',
          answer: null,
          awaitingSecond: null,
        },
      ],
    });
    await type(page, '[data-stop="amount"]', '5000');
    await press(page, '[data-stop="top-up"]');
    expect(sent.map((call) => call.route)).toStrictEqual(['run/top_up']);
    expect(sent[0]?.body['currency']).toBe('JPY');
    expect(sent[0]?.body['amountMinor'], 'yen typed are yen minor units (JPY has 0 digits)').toBe(
      5_000,
    );
  });
});
