// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, sections 006 and 008: a live grant's time left is the
// kit's countdown (DS-PRIM-25), and the night round's lede starts the window
// on the evening before the date the brief is handed over. Sol's two proofs
// from #1385's review, assertions as written.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SignalSections } from '../../apps/web/src/screens/connections/signal.tsx';
import type { ConnectionSignalResult } from '../../packages/core-wire/src/index.ts';
import { mount, settle } from './mount.tsx';

const NOW = Date.parse('2026-09-29T00:00:00Z');
const signal: ConnectionSignalResult = {
  ok: true,
  grants: [
    {
      id: 'grant-1',
      agentId: 'agent-0000-0000-000000000000',
      purpose: 'band_update',
      collections: ['task'],
      access: 'read',
      client: null,
      grantedAt: '2026-09-28T22:00:00Z',
      expiresAt: '2026-09-29T00:37:00Z',
      endedAt: null,
      revocationCause: null,
      state: 'live',
      redemptions: 1,
    },
  ],
  grantCounts: { live: 1, ranOut: 0, takenBack: 0, liveExec: 0 },
  tripwires: [],
  tripwireCounts: { armed: 0, cannotBeArmed: 0 },
  nightRound: {
    roundOn: '2026-09-29',
    notClean: 0,
    steps: [
      {
        id: 'start',
        at: '2026-09-28T13:00:00Z',
        tone: 'plain',
        what: 'The round begins',
        who: 'night.reader',
        say: 'Started at 23:00 on 28 September in Brisbane',
        cite: null,
      },
    ],
  },
  roster: [],
};

async function open() {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(signal), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
  const page = await mount(
    <SignalSections client={client} grantKey="alpha:sol:0" clock={() => NOW} />,
  );
  await settle();
  expect(page.find('#night-round')).not.toBeNull();
  return page;
}

it('the night window starts on the evening before its hand-over date', async () => {
  const page = await open();
  try {
    expect(page.find('[data-night-step="start"] time')?.textContent).toBe('23:00');
    expect(page.find('[data-night-lede]')?.textContent).toMatch(/28 Sept.*23:00.*08:10/u);
  } finally {
    await page.unmount();
  }
});

it('a live grant uses the kit countdown warning treatment', async () => {
  const page = await open();
  try {
    const countdown = page.find('[data-grant-ttl].ttl, [data-grant-ttl] .ttl');
    expect(countdown, 'DS-PRIM-25 countdown treatment is present').not.toBeNull();
    expect(countdown?.classList.contains('is-soon')).toBe(true);
    expect(countdown?.textContent).toBe('37 min left');
  } finally {
    await page.unmount();
  }
});
