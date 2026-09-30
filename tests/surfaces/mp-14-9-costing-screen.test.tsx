// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-9, the browser's half of skill costing: section 009 on Connections &
// signal (U39, #492). The server is a stub that answers `finance.skill_costs`
// with the case's own body, the fleet and the per-client region with small
// bodies of their own, and records every call. The read's own cases, its
// scoping and isolation included, are `tests/costs/mp-14-9-skill-costs.test.ts`.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type {
  ConnectionGraduationResult,
  SkillCostView,
  SkillCostsResult,
} from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const REASON = 'Process documents open at their Docs address once Docs exists.';

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

function skill(id: string, figure: SkillCostView['figure'], extra: Partial<SkillCostView> = {}) {
  return {
    skillId: id,
    name: `Skill ${id}`,
    currency: 'AUD',
    runs: 3,
    soloRuns: 2,
    sharedRuns: 1,
    unpricedRuns: 0,
    tasks: 2,
    figure,
    soloTotal: '2400',
    usage: { measuredRuns: 0, meanIn: null, meanOut: null },
    models: { ids: ['claude-opus-5-5'], unnamedCalls: 0 },
    document: { available: false, reason: REASON },
    ...extra,
  } satisfies SkillCostView;
}

const MEAN = skill(
  'mean',
  { kind: 'mean', mean: '1200', lo: '800', hi: '1600', finishedMean: '1500' },
  {
    usage: { measuredRuns: 2, meanIn: '5200', meanOut: '900' },
    models: { ids: ['claude-opus-5-5', 'claude-haiku-4-5-20251001'], unnamedCalls: 1 },
  },
);
const ONE = skill('one', { kind: 'one', amount: '450' }, { runs: 1, soloRuns: 1, sharedRuns: 0 });
const NONE = skill('none', { kind: 'none' }, { soloRuns: 0, sharedRuns: 2, soloTotal: '0' });

const COSTING: SkillCostsResult = {
  ok: true,
  costing: {
    skills: [MEAN, ONE, NONE],
    split: [
      {
        currency: 'AUD',
        runs: 10,
        total: '10000',
        solo: { runs: 3, total: '2840' },
        shared: { runs: 3, total: '2160' },
        unattributed: { runs: 4, total: '5000' },
        unpricedRuns: 1,
      },
    ],
  },
};

const REGION: ConnectionGraduationResult = {
  ok: true,
  clients: [{ id: 'k-a', label: 'Client A', scopes: ['*'] }],
  rows: [],
  mandates: [],
};

const opened: Mounted[] = [];

async function open(
  costs: SkillCostsResult | 'refused',
): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/finance/skill_costs')) {
      return Promise.resolve(
        costs === 'refused'
          ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403)
          : json(costs),
      );
    }
    if (at.endsWith('/connection/graduation')) return Promise.resolve(json(REGION));
    if (at.endsWith('/connection/fleet')) {
      return Promise.resolve(
        json({
          ok: true,
          connections: [],
          counts: { all: 0, active: 0, degraded: 0, broken: 0, clientConnections: 0 },
        }),
      );
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });
  const page = await mount(<ConnectionsScreen client={client} now={() => NOW} />);
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

const text = (page: Mounted, selector: string): string => page.find(selector)?.textContent ?? '';

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('MP-14-9 Connections & signal: skill costing', () => {
  it('MP-14-9 owner check: skill costing shows each skill’s cost, and its process document link is drawn unavailable with its reason until Docs exists', async () => {
    const { page, sent } = await open(COSTING);
    expect(text(page, '[data-skill="mean"]')).toContain('AUD 12.00');
    expect(text(page, '[data-skill="one"]')).toContain('AUD 4.50');
    expect(text(page, '[data-skill="none"]')).toContain('No run has used this process on its own');
    for (const id of ['mean', 'one', 'none']) {
      const link = page.find(`[data-skill="${id}"] [data-skill-doc]`);
      expect(link?.textContent).toBe(`Skill ${id}`);
      expect(link?.getAttribute('aria-disabled')).toBe('true');
      expect(link?.hasAttribute('href')).toBe(false);
      expect(link?.getAttribute('title')).toBe(REASON);
    }
    // Doors and view state only: the page reads and sends nothing else.
    expect(sent.every((call) => /\/(connection|finance)\//u.test(call))).toBe(true);
  });

  it('MP-14-9 the section is absent when nothing has run', async () => {
    const nothing = await open({ ok: true, costing: null });
    expect(nothing.page.find('[data-costing]')).toBeNull();
    expect(nothing.page.find('[data-section="009"]')).toBeNull();
    await nothing.page.unmount();
    const refused = await open('refused');
    expect(refused.page.find('[data-costing]')).toBeNull();
  });

  it('MP-14-9 three figure branches: mean with spread, one run, none', async () => {
    const { page } = await open(COSTING);
    expect(page.find('[data-skill="mean"] [data-figure]')?.getAttribute('data-figure')).toBe(
      'mean',
    );
    expect(text(page, '[data-skill="mean"] [data-figure]')).toContain('AUD 12.00 mean');
    expect(text(page, '[data-skill="mean"] [data-figure-spread]')).toBe('AUD 8.00–AUD 16.00');
    expect(text(page, '[data-skill="mean"] [data-figure-units]')).toBe('5,200 in · 900 out');
    expect(text(page, '[data-skill="mean"] [data-finished-only]')).toContain('AUD 15.00');
    expect(text(page, '[data-skill="mean"] [data-models]')).toContain(
      'claude-opus-5-5 claude-haiku-4-5-20251001',
    );
    expect(text(page, '[data-skill="mean"] [data-models]')).toContain('1 call named no model');

    expect(page.find('[data-skill="one"] [data-figure]')?.getAttribute('data-figure')).toBe('one');
    expect(text(page, '[data-skill="one"] [data-figure]')).toContain('AUD 4.50 one run');
    expect(text(page, '[data-skill="one"] [data-figure]')).toContain(
      'Not an average — this process has run once.',
    );
    expect(page.find('[data-skill="one"] [data-figure-spread]')).toBeNull();

    expect(page.find('[data-skill="none"] [data-figure]')?.getAttribute('data-figure')).toBe(
      'none',
    );
    expect(text(page, '[data-skill="none"] [data-figure]')).not.toMatch(/AUD|\b0\b/u);
    expect(text(page, '[data-skill="none"] [data-observed]')).toContain(
      'no run of its own, across 2 tasks · 2 further runs alongside another skill',
    );
    expect(text(page, '[data-costing-lede]')).toContain(
      '3 processes have run at least once, and 2 of them not often enough to average.',
    );
  });

  it('MP-14-9 attribution buckets add back to the total', async () => {
    const { page } = await open(COSTING);
    const foot = '[data-split="AUD"]';
    expect(text(page, `${foot} [data-split-total]`)).toBe(
      'Of AUD 100.00 on record, across 10 runs',
    );
    const shown = ['solo', 'shared', 'unattributed'].map((bucket) =>
      text(page, `${foot} [data-bucket="${bucket}"]`),
    );
    expect(shown[0]).toContain('AUD 28.40 across 3 runs used ONE process (28%)');
    expect(shown[1]).toContain('AUD 21.60 across 3 used SEVERAL and is averaged into none (22%)');
    expect(shown[2]).toContain('AUD 50.00 across 4 names NO process at all (50%)');
    const minor = page
      .all(`${foot} [data-bucket]`)
      .map((one) => Number(one.getAttribute('data-minor')));
    expect(minor.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(text(page, `${foot} [data-split-unpriced]`)).toContain('1 run has no known cost yet');
  });

  it('MP-14-9 section numbers read top to bottom; skill costing is 009 (R61)', async () => {
    const { page } = await open(COSTING);
    const numbers = page.all('[data-section]').map((one) => one.getAttribute('data-section'));
    expect(numbers).toEqual(numbers.toSorted());
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toContain('012');
    expect(text(page, '[data-section="009"] h2')).toContain('009 Skill costing');
    expect(text(page, '[data-section="010"] h2')).toContain('010 Graduation');
  });
});
