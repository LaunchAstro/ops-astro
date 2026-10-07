// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Executive page as the application draws it, through the screen
// registry: what our agents cost us is an agency-wide rollup no topic reaches
// (CS-1.2), so an open page re-reads it on the tab's floor. The server is a
// stub that answers `finance.agent_costs` with whatever the case holds at the
// time and records every call.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import type { AgentCostsResult } from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const UNPRICED = 'A call’s cost is not known yet: it is still running or its liability is unknown.';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One run started on 20 September, with its cost once it has settled. */
function costs(cost: string | null): AgentCostsResult {
  const attachment = { kind: 'agency' } as const;
  const unpricedRuns = cost === null ? 1 : 0;
  const totals = { currency: 'AUD', runs: 1, unpricedRuns, total: cost ?? '0' };
  return {
    ok: true,
    period: { from: '2026-08-31T12:00:00.000Z', to: '2026-09-30T12:00:00.000Z' },
    runs: [
      {
        runId: 'r-1',
        taskId: 't-1',
        agentActorId: 'a-1111aaaa-0000',
        attachment,
        currency: 'AUD',
        cost,
        unpriced: cost === null ? UNPRICED : null,
        startedAt: '2026-09-20T01:00:00.000Z',
        models: { ids: ['claude-haiku-4-5-20251001'], unnamedCalls: 0 },
      },
    ],
    byAgent: [{ agentActorId: 'a-1111aaaa-0000', ...totals }],
    byAttachment: [{ attachment, ...totals }],
  };
}

/** Advance fake time by `ms`, letting the reads it starts land. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const opened: Mounted[] = [];

/** Executive as the application draws it, answering each read with `answer()` at the time. */
async function open(
  answer: () => AgentCostsResult,
): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    sent.push(`${String(url)} ${String(init?.body ?? '')}`);
    return Promise.resolve(json(answer()));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(
    SCREENS['agency:executive']({
      client,
      grantKey: 'alpha:a@x:0',
      params: {},
      notice: null,
      storage: null,
      navigate: () => {},
    }),
  );
  opened.push(page);
  return { page, sent };
}

afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const runRow = (page: Mounted): string =>
  page.find('[data-cost-run="r-1"]')?.closest('tr')?.textContent ?? '';

describe('Executive: what our agents cost us, kept fresh', () => {
  it('the open page re-reads its costs on the 30-second floor, when shown again and when back online', async () => {
    vi.useFakeTimers({ now: NOW });
    let shown: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => shown);
    const flip = (to: DocumentVisibilityState): void => {
      shown = to;
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };
    let cost: string | null = null;
    const { page, sent } = await open(() => costs(cost));
    await pass(1);
    expect(runRow(page)).toContain('no price yet');
    // The run settles while the page stays open: within 30 s it shows its cost.
    cost = '1234';
    await pass(FLOOR_MS);
    expect(sent).toHaveLength(2);
    expect(runRow(page)).toContain('AUD 12.34');
    // Hidden, it reads nothing; shown again, it reads at once; back online, at once again.
    flip('hidden');
    await pass(FLOOR_MS * 3);
    expect(sent).toHaveLength(2);
    flip('visible');
    await pass(1);
    expect(sent).toHaveLength(3);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await pass(1);
    expect(sent).toHaveLength(4);
    // Every re-read asks for the period fixed when the page opened.
    expect(new Set(sent).size).toBe(1);
    expect(sent[0]).toContain('"to":"2026-09-30T12:00:00.000Z"');
  });
});
