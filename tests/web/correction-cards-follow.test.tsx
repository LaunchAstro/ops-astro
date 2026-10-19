// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1695: the correction cards in the live app. A card comes from
// `live_correction.list`, so it is drawn again after a reload; an approved or
// accepted card reads its correction again every few seconds until a final
// state; a published card opens its receipts (`live_correction.receipts`);
// and the person's approve is the button "Launch". The server's decision
// stays `approve`.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLLOW_MS } from '../../apps/web/src/assistant/use-corrections.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { V1, card, controls, refusal } from './sidebar-corrections-support.tsx';

const ITEM = {
  correctionId: 'c-1',
  taskId: '22222222-2222-4222-8222-222222222222',
  approver: null,
  versionId: V1,
  pageUrl: 'https://agencyastro.com/about',
  word: 'alongside',
  replacement: 'beside',
  requestedAt: '2026-10-18T01:00:00.000Z',
};

const RECEIPT = {
  receiptId: 'r-1',
  step: 'publish',
  outcome: 'live',
  recordedAt: '2026-10-18T01:05:00.000Z',
  commit: '0a1b2c3d4e5f',
  deploymentId: 'dpl_7sodhsq',
  beforeCapture: { text: 'We work alongside the teams.', clipped: false },
  afterCapture: { text: 'We work beside the teams.', clipped: true },
};

/**
 * One business's API: the list answers `listed`, each read of c-1 takes the
 * next state in `states` (the last repeating) with a check good for
 * `verifiedForMs`, and every call is kept.
 */
function api(
  businessKey: string,
  listed: readonly string[],
  states: readonly string[] = [],
  verifiedForMs = 60_000,
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const path = at.slice(at.indexOf(`/api/b/${businessKey}`) + `/api/b/${businessKey}`.length);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    const reads = calls.filter((call) => call.path === '/live_correction/read').length;
    const state = states[Math.min(reads, states.length) - 1] ?? 'requested';
    if (path === '/live_correction/list') {
      const corrections = listed.map((one, nth) => ({
        ...ITEM,
        correctionId: `c-${String(nth + 1)}`,
        state: one,
      }));
      return Promise.resolve(json({ ok: true, corrections }));
    }
    if (path === '/live_correction/read') {
      const correction = { correctionId: 'c-1', state, approver: 'Grace Hopper', versionId: V1 };
      return Promise.resolve(json({ ok: true, correction: { ...correction, verifiedForMs } }));
    }
    if (path === '/live_correction/receipts') {
      return Promise.resolve(json({ ok: true, correctionId: 'c-1', receipts: [RECEIPT] }));
    }
    if (path === '/live_correction/decide') return Promise.resolve(json({ recordId: 'c-1' }));
    return Promise.resolve(refusal('NOT_FOUND', 404));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  const sent = (path: string) => calls.filter((call) => call.path === path);
  return { client, sent };
}

/** Move the fake clocks on by `ms` a second at a time, letting React draw each answer as it lands. */
const stepped = async (ms: number): Promise<void> => {
  for (let left = ms; left > 0; left -= 1000) {
    // oxlint-disable-next-line no-await-in-loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(1000, left));
    });
  }
};

afterEach(unmountAll);

describe('a card survives a reload', () => {
  it('a fresh mount lists the business’s corrections with their current state', async () => {
    const { client } = api('alpha', ['live', 'requested']);
    const view = await mount(<SidebarCorrections client={client} />);
    await tick();
    const states = view
      .all('[data-correction-card]')
      .map((one) => (one as HTMLElement).dataset['correctionState']);
    expect(states.toSorted()).toStrictEqual(['published', 'requested']);
    expect(card(view)?.textContent).toContain('alongside');
    expect(card(view)?.textContent).toContain('beside');
  });

  it('draws the cards with no door where the host hands in no site read', async () => {
    const { client } = api('alpha', ['requested']);
    const view = await mount(<SidebarCorrections client={client} />);
    await tick();
    expect(view.find('[data-correction-door]')).toBeNull();
    expect(view.all('[data-correction-card]')).toHaveLength(1);
  });

  it('says a refused list in plain words, never its code', async () => {
    const fetch = (() =>
      Promise.resolve(refusal('CONTENT_DRIFTED', 409))) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const view = await mount(<SidebarCorrections client={client} />);
    await tick();
    expect(view.find('[data-correction-list-refusal]')?.textContent).toMatch(/page changed/iu);
    expect(view.text()).not.toContain('CONTENT_DRIFTED');
  });
});

describe('an approved card follows its correction until a final state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns to Published on its own, then stops reading', async () => {
    const { client, sent } = api('alpha', ['accepted'], ['accepted', 'accepted', 'live']);
    const view = await mount(<SidebarCorrections client={client} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(card(view)?.dataset['correctionState']).toBe('approved');
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 3);
    expect(card(view)?.dataset['correctionState']).toBe('published');
    const reads = sent('/live_correction/read').length;
    expect(reads).toBe(3);
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 5);
    expect(sent('/live_correction/read')).toHaveLength(reads);
  });

  it('never follows a waiting card; it reads it only to renew Launch’s check', async () => {
    // The waiting card is read once its (absent) check has lapsed, at 10 s; each read's
    // check holds 20 s, so the next renewal is at 30 s, and nothing in between.
    const { client, sent } = api('alpha', ['requested', 'live', 'failed', 'rejected'], [], 20_000);
    await mount(<SidebarCorrections client={client} />);
    await stepped(FOLLOW_MS * 5);
    expect(sent('/live_correction/read').map((call) => call.body)).toStrictEqual([
      { correctionId: 'c-1' },
    ]);
    await stepped(16_000);
    expect(sent('/live_correction/read')).toHaveLength(2);
    await stepped(18_000);
    expect(sent('/live_correction/read')).toHaveLength(2);
  });

  it('stops following once the drawer is gone', async () => {
    const { client, sent } = api('alpha', ['approved'], ['approved']);
    const view = await mount(<SidebarCorrections client={client} />);
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 2);
    const reads = sent('/live_correction/read').length;
    expect(reads).toBeGreaterThan(0);
    await view.unmount();
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 5);
    expect(sent('/live_correction/read')).toHaveLength(reads);
  });
});

describe('a published card shows its receipts', () => {
  it('opens the commit, the deployment and the before and after captures', async () => {
    const { client, sent } = api('alpha', ['live']);
    const view = await mount(<SidebarCorrections client={client} />);
    await tick();
    expect(sent('/live_correction/receipts')).toHaveLength(0);
    await view.click('[data-correction-receipts-open]');
    await tick();
    expect(sent('/live_correction/receipts').map((call) => call.body)).toStrictEqual([
      { correctionId: 'c-1' },
    ]);
    const receipts = view.find('[data-correction-receipts]')?.textContent ?? '';
    expect(receipts).toContain('0a1b2c3d4e5f');
    expect(receipts).toContain('dpl_7sodhsq');
    expect(receipts).toContain('We work alongside the teams.');
    expect(receipts).toContain('We work beside the teams.');
    expect(receipts).toMatch(/cut short/iu);
  });

  it('offers no receipts on a card that has not been published', async () => {
    const { client } = api('alpha', ['requested', 'approved']);
    const view = await mount(<SidebarCorrections client={client} />);
    await tick();
    expect(view.find('[data-correction-receipts-open]')).toBeNull();
  });
});

describe('the button reads Launch', () => {
  it('a waiting card offers Launch and Decline, and Launch sends approve on its version', async () => {
    // The listed card offers Launch once a read's check holds: the card reads it at 10 s.
    vi.useFakeTimers();
    const { client, sent } = api('alpha', ['requested'], ['requested', 'approved']);
    const view = await mount(<SidebarCorrections client={client} />);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await tick();
    expect(controls(view)).toStrictEqual(['Launch', 'Decline']);
    await view.click('[data-correction-decide="approve"]');
    await tick();
    expect(sent('/live_correction/decide').map((call) => call.body)).toMatchObject([
      { correctionId: 'c-1', versionId: V1, decision: 'approve' },
    ]);
  });
});

/**
 * Alpha's API whose answers wait until released, newest call first or in any
 * order the test names: the list answers one accepted correction, and each
 * read answers the state queued for it.
 */
function heldApi(businessKey: string, states: readonly string[]) {
  const waiting: (() => void)[] = [];
  let reads = 0;
  const fetch = ((url: string | URL) => {
    const at = String(url);
    const answer = at.endsWith('/live_correction/list')
      ? json({ ok: true, corrections: [{ ...ITEM, state: 'accepted' }] })
      : json({
          ok: true,
          correction: {
            correctionId: 'c-1',
            state: states[reads++] ?? 'accepted',
            approver: 'Grace Hopper',
            versionId: V1,
          },
        });
    return new Promise<Response>((resolve) => {
      waiting.push(() => {
        resolve(answer);
      });
    });
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  return { client, waiting };
}

describe('only the newest answer lands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a follow-up read overtaken by a newer one is dropped when it lands late', async () => {
    const { client, waiting } = heldApi('alpha', ['accepted', 'live']);
    const view = await mount(<SidebarCorrections client={client} />);
    waiting.shift()?.();
    // The answer's body is read in two turns of the loop.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(card(view)?.dataset['correctionState']).toBe('approved');
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 2);
    // Two follow-up reads are out, neither answered yet.
    expect(waiting).toHaveLength(2);
    const [older, newer] = waiting.splice(0);
    newer?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(card(view)?.dataset['correctionState']).toBe('published');
    older?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(card(view)?.dataset['correctionState']).toBe('published');
  });

  it('a list that lands after a switch of business draws on its own business only', async () => {
    const alpha = heldApi('alpha', []);
    const bravo = api('bravo', []);
    const view = await mount(<SidebarCorrections client={alpha.client} />);
    await view.render(<SidebarCorrections client={bravo.client} />);
    alpha.waiting.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.all('[data-correction-card]')).toHaveLength(0);
    await view.render(<SidebarCorrections client={alpha.client} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.all('[data-correction-card]')).toHaveLength(1);
  });
});
