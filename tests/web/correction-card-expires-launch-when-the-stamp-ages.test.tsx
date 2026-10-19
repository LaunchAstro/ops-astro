// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The card's Approve stands on a checked version for as long as the check
// holds (#1693). The read answers how long the check holds (`verifiedForMs`);
// the card arms its clock from `performance.now()` when the answer arrives,
// takes Approve away once that time has passed, says it is checking the page
// again and sends one re-read. A later read with a fresh check brings Approve
// back. The wall clock (`Date.now`) plays no part.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { ABOUT, V1, V2, card, mockPropose, type View } from './sidebar-corrections-support.tsx';

const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const asRead = (versionId: string | null, verifiedForMs: number, state = 'requested'): Response =>
  json({
    ok: true,
    correction: {
      correctionId: 'mock-correction-1',
      state,
      approver: null,
      versionId,
      verifiedAt: verifiedForMs > 0 ? '2026-10-19T00:00:00.000Z' : null,
      verifiedForMs,
      refusal: null,
    },
  });

/** Alpha's API: each read takes the next answer queued, the last one repeating. */
function scripted(reads: readonly Response[]) {
  let sent = 0;
  const fetch = ((url: string | URL) => {
    if (!String(url).endsWith('/live_correction/read')) throw new Error(`sent ${String(url)}`);
    sent += 1;
    const answer = reads[Math.min(sent, reads.length) - 1];
    if (answer === undefined) throw new Error('nothing scripted');
    return Promise.resolve(answer.clone());
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, reads: () => sent };
}

/** Move the fake clocks on by `ms`, letting every answer due land. */
const after = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** The door's ask, typed and sent, with its first read answered at the same instant. */
async function asked(reads: readonly Response[]) {
  const server = scripted(reads);
  const view = await mount(
    <SidebarCorrections client={server.client} propose={mockPropose().port} />,
  );
  await view.type('[data-correction-door] [name="page"]', ABOUT.page);
  await view.type('[data-correction-door] [name="word"]', ABOUT.word);
  await view.type('[data-correction-door] [name="replacement"]', ABOUT.replacement);
  await view.click('[data-correction-ask]');
  await after(0);
  return { view, reads: server.reads };
}

const approvable = (view: View): boolean =>
  view.find('[data-correction-decide="approve"]') !== null;

const checking = (view: View): boolean =>
  (card(view)?.textContent ?? '').includes('Checking the page again…');

describe('Approve lasts as long as the check the read answered', () => {
  it('a check good for 20 s draws Approve at 19.9 s and takes it away at 20 s, with one re-read', async () => {
    const { view, reads } = await asked([asRead(V1, 20_000), asRead(V1, 0)]);
    expect(reads()).toBe(1);
    expect(approvable(view)).toBe(true);
    await after(19_900);
    expect(approvable(view)).toBe(true);
    expect(checking(view)).toBe(false);
    expect(reads()).toBe(1);
    await after(100);
    expect(approvable(view)).toBe(false);
    expect(checking(view)).toBe(true);
    expect(reads()).toBe(2);
  });

  it('a check good for 0 ms never draws Approve', async () => {
    const { view } = await asked([asRead(V1, 0)]);
    expect(approvable(view)).toBe(false);
    for (let at = 0; at < 6; at += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await after(10_000);
      expect(approvable(view)).toBe(false);
    }
  });

  it('a later read with a fresh check draws Approve again', async () => {
    const { view, reads } = await asked([asRead(V1, 20_000), asRead(V1, 0), asRead(V2, 20_000)]);
    await after(20_000);
    expect(approvable(view)).toBe(false);
    expect(reads()).toBe(2);
    await after(10_000);
    expect(reads()).toBe(3);
    expect(approvable(view)).toBe(true);
    expect(checking(view)).toBe(false);
  });
});

describe('the card times the check from the answer, never the wall clock', () => {
  it('the wall clock moved an hour either way changes nothing', async () => {
    const { view, reads } = await asked([asRead(V1, 20_000), asRead(V1, 0)]);
    await after(5000);
    vi.setSystemTime(Date.now() + HOUR);
    await after(0);
    expect(approvable(view)).toBe(true);
    await after(14_900);
    vi.setSystemTime(Date.now() - 2 * HOUR);
    await after(0);
    expect(approvable(view)).toBe(true);
    expect(reads()).toBe(1);
    await after(100);
    expect(approvable(view)).toBe(false);
    expect(reads()).toBe(2);
  });
});

describe('the card reads again on its own cadence, and stops', () => {
  it('waiting without a check, it reads every 10 s for at most 10 minutes', async () => {
    const { reads } = await asked([asRead(V1, 0)]);
    await after(10_000);
    expect(reads()).toBe(2);
    await after(590_000);
    const atTenMinutes = reads();
    expect(atTenMinutes).toBeLessThanOrEqual(61);
    await after(600_000);
    expect(reads()).toBe(atTenMinutes);
  });

  it('while the page is being found, it reads every 5 s for at most 3 minutes', async () => {
    const { reads } = await asked([asRead(null, 0, 'locating')]);
    await after(5000);
    expect(reads()).toBe(2);
    await after(175_000);
    const atThreeMinutes = reads();
    expect(atThreeMinutes).toBeLessThanOrEqual(37);
    await after(180_000);
    expect(reads()).toBe(atThreeMinutes);
  });
});
