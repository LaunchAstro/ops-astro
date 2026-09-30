// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-6, the browser's half of what our agents cost us: section 005 of the
// Executive page (U39, #489; mockup `/agency/executive/` #agentcost). The
// server is a stub that answers `finance.agent_costs` with the case's own body
// and records every call. The read's own cases, its scoping and isolation
// included, are `tests/costs/mp-14-6-agent-costs.test.ts`.

import { readFileSync } from 'node:fs';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutiveScreen } from '../../apps/web/src/screens/Executive.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { namespaceOf } from '../../apps/web/src/manifest.ts';
import type {
  AgentCostRowView,
  AgentCostsResult,
  CostAttachment,
} from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const LONG_ID = 'claude-opus-5-5-20260901-extended-context';
const UNPRICED = 'A call’s cost is not known yet: it is still running or its liability is unknown.';
const MERIDIAN: CostAttachment = { kind: 'client', id: 'c-1', name: 'Meridian Dental' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

function run(index: number, extra: Partial<AgentCostRowView> = {}): AgentCostRowView {
  return {
    runId: `r-${String(index)}`,
    taskId: `t-${String(index)}`,
    agentActorId: 'a-1111aaaa-0000',
    attachment: MERIDIAN,
    currency: 'AUD',
    cost: '100',
    unpriced: null,
    startedAt: `2026-09-${String(10 + index).padStart(2, '0')}T01:00:00.000Z`,
    models: { ids: ['claude-haiku-4-5-20251001'], unnamedCalls: 0 },
    ...extra,
  };
}

const RUNS: readonly AgentCostRowView[] = [
  run(1, { cost: '1234', models: { ids: [LONG_ID], unnamedCalls: 0 } }),
  run(2, { attachment: { kind: 'agency' }, cost: null, unpriced: UNPRICED }),
  ...Array.from({ length: 9 }, (_unused, index) =>
    run(index + 3, { agentActorId: 'a-2222bbbb-0000' }),
  ),
];

const COSTS: AgentCostsResult = {
  ok: true,
  period: { from: '2026-08-31T12:00:00.000Z', to: '2026-09-30T12:00:00.000Z' },
  runs: RUNS,
  byAgent: [
    { agentActorId: 'a-1111aaaa-0000', currency: 'AUD', runs: 2, unpricedRuns: 1, total: '1234' },
    { agentActorId: 'a-2222bbbb-0000', currency: 'AUD', runs: 9, unpricedRuns: 0, total: '900' },
  ],
  byAttachment: [
    { attachment: MERIDIAN, currency: 'AUD', runs: 10, unpricedRuns: 0, total: '2134' },
    { attachment: { kind: 'agency' }, currency: 'AUD', runs: 1, unpricedRuns: 1, total: '0' },
  ],
};

const opened: Mounted[] = [];

async function open(
  costs: AgentCostsResult | 'refused',
): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/finance/agent_costs')) {
      return Promise.resolve(
        costs === 'refused'
          ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403)
          : json(costs),
      );
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<ExecutiveScreen client={client} now={() => NOW} />);
  opened.push(page);
  await tick();
  return { page, sent };
}

afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
});

const text = (page: Mounted, selector: string): string => page.all(selector)[0]?.textContent ?? '';

/** An element's data attributes, read through the DOM's own map. */
const data = (element: Element | null | undefined): DOMStringMap =>
  element instanceof HTMLElement ? element.dataset : {};

/** A cost log row: the kit's table marks its first cell, so the row is that cell's own. */
const logRow = (page: Mounted, runId: string): Element | null =>
  page.find(`[data-cost-run="${runId}"]`)?.closest('tr') ?? null;

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('MP-14-6 What our agents cost us', () => {
  it('MP-14-6 owner check: spend per agent and per client shows for the period', async () => {
    const { page, sent } = await open(COSTS);
    // One read, for the last thirty days to now.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('/finance/agent_costs');
    expect(sent[0]).toContain('"from":"2026-08-31T12:00:00.000Z"');
    expect(sent[0]).toContain('"to":"2026-09-30T12:00:00.000Z"');
    expect(text(page, '[data-section="005"] h2')).toContain('What our agents cost us');
    expect(text(page, '[data-cost-period]')).toBe('31 Aug 2026 to 30 Sept 2026');
    expect(text(page, '[data-cost-agent="a-1111aaaa-0000"]')).toContain('AUD 12.34');
    expect(text(page, '[data-cost-agent="a-2222bbbb-0000"]')).toContain('AUD 9.00');
    expect(text(page, '[data-cost-attached="c-1"]')).toContain('Meridian Dental');
    expect(text(page, '[data-cost-attached="c-1"]')).toContain('AUD 21.34');
    expect(text(page, '[data-cost-kpi="total-AUD"]')).toContain('AUD 21.34');
    expect(text(page, '[data-cost-kpi="runs"]')).toContain('11');
  });

  it('MP-14-6 exact model ids wrap and never truncate', async () => {
    const { page } = await open(COSTS);
    const id = logRow(page, 'r-1')?.querySelector('.skc__model');
    expect(id?.textContent).toBe(LONG_ID);
    expect(page.text()).not.toContain('…');
    const css = readFileSync('apps/web/src/styles/6-slice.css', 'utf8');
    const rule = /\.skc__model\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/u);
    expect(rule).not.toMatch(/text-overflow|nowrap/u);
  });

  it('MP-14-6 unpriced runs say so', async () => {
    const { page } = await open(COSTS);
    const cell = logRow(page, 'r-2')?.querySelector('[data-cost-unpriced]');
    expect(cell?.textContent).toBe('no price yet');
    expect(cell?.getAttribute('title')).toBe(UNPRICED);
    expect(logRow(page, 'r-2')?.textContent).not.toMatch(/AUD 0\.00/u);
    expect(text(page, '[data-cost-kpi="unpriced"]')).toContain('1');
  });

  it('MP-14-6 attachment falls back to "the agency"', async () => {
    const { page } = await open(COSTS);
    expect(logRow(page, 'r-2')?.querySelector('[data-cost-who]')?.textContent).toBe('the agency');
    expect(text(page, '[data-cost-attached="agency"]')).toContain('the agency');
    expect(logRow(page, 'r-1')?.querySelector('[data-cost-who]')?.textContent).toBe(
      'Meridian Dental',
    );
  });

  it('MP-14-6 the cost log folds at 8 rows with "Show n more", as the book does', async () => {
    const { page } = await open(COSTS);
    expect(page.all('[data-cost-run]')).toHaveLength(8);
    expect(text(page, '[data-cost-more]')).toBe('Show 3 more');
    await page.click('[data-cost-more]');
    expect(page.all('[data-cost-run]')).toHaveLength(11);
    expect(page.find('[data-cost-more]')).toBeNull();
  });

  it('MP-14-6 internal face only', async () => {
    const { page } = await open(COSTS);
    expect(data(page.find('[data-section="005"]'))['view']).toBe('agency');
    expect(matchRoute('/dashboard/executive/')?.id).toBe('agency:executive');
    expect(namespaceOf('/dashboard/executive/')).toBe('agency');
    // Cost to us, never billable: no invoice words anywhere in the section.
    expect(text(page, '[data-section="005"]')).not.toMatch(/invoice|bill(ed|able)?\b|owed/iu);
  });

  it('MP-14-6 nothing ran, or the read is refused: said plainly, never a zero', async () => {
    const none = await open({ ...COSTS, runs: [], byAgent: [], byAttachment: [] });
    expect(text(none.page, '[data-section="005"]')).toContain('No agent ran in this period.');
    expect(none.page.find('[data-cost-run]')).toBeNull();
    await none.page.unmount();
    const refused = await open('refused');
    expect(refused.page.find('[data-agent-costs]')).toBeNull();
  });
});
