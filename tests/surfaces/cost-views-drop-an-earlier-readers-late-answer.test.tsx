// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Both live cost views drawn again for another reader, in another business or
// the same one, never draw the earlier reader's answer when it lands late: the
// agent costs on Executive and the skill costing on Connections & signal.

import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { AgentCostSection } from '../../apps/web/src/screens/executive/agent-costs.tsx';
import { SkillCostingSection } from '../../apps/web/src/screens/connections/costing.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type {
  AgentCostRowView,
  AgentCostsResult,
  SkillCostView,
  SkillCostsResult,
} from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

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

function agentCosts(client: string): AgentCostsResult {
  const attachment = { kind: 'client', id: 'c-1', name: client } as const;
  const row: AgentCostRowView = {
    runId: 'r-1',
    taskId: 't-1',
    agentActorId: 'a-1',
    attachment,
    currency: 'AUD',
    cost: '100',
    unpriced: null,
    startedAt: '2026-09-20T01:00:00.000Z',
    models: { ids: ['claude-haiku-4-5-20251001'], unnamedCalls: 0 },
  };
  const line = { currency: 'AUD', runs: 1, unpricedRuns: 0, total: '100' };
  return {
    ok: true,
    period: { from: '2026-08-31T12:00:00.000Z', to: '2026-09-30T12:00:00.000Z' },
    runs: [row],
    byAgent: [{ agentActorId: 'a-1', ...line }],
    byAttachment: [{ attachment, ...line }],
  };
}

function skillCosts(name: string): SkillCostsResult {
  const skill: SkillCostView = {
    skillId: 's-1',
    name,
    currency: 'AUD',
    runs: 1,
    soloRuns: 1,
    sharedRuns: 0,
    unpricedRuns: 0,
    tasks: 1,
    figure: { kind: 'one', amount: '450' },
    soloTotal: '450',
    usage: { measuredRuns: 0, meanIn: null, meanOut: null },
    models: { ids: [], unnamedCalls: 0 },
    document: { available: false, reason: 'Process documents open once Docs exists.' },
  };
  const bucket = { runs: 1, total: '450' };
  return {
    ok: true,
    costing: {
      skills: [skill],
      split: [
        {
          currency: 'AUD',
          runs: 1,
          total: '450',
          solo: bucket,
          shared: { runs: 0, total: '0' },
          unattributed: { runs: 0, total: '0' },
          unpricedRuns: 0,
        },
      ],
    },
  };
}

/** A client whose cost reads answer `body`, at once or when `release` is called. */
function reader(business: string, body: unknown, hold = false) {
  const held: (() => void)[] = [];
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (!at.endsWith('/finance/agent_costs') && !at.endsWith('/finance/skill_costs')) {
      return Promise.resolve(json({ ok: true }));
    }
    if (!hold) return Promise.resolve(json(body));
    return new Promise<Response>((resolve) => {
      held.push(() => resolve(json(body)));
    });
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: business, signedIn: true, fetch });
  return {
    client,
    release: () => {
      for (const one of held) one();
    },
  };
}

type Draw = (client: OperationsClient, grantKey: string) => ReactElement;

const VIEWS: readonly (readonly [string, Draw, (marker: string) => unknown])[] = [
  [
    'agent costs',
    (client, grantKey) => (
      <AgentCostSection
        client={client}
        grantKey={grantKey}
        now={() => Date.parse('2026-09-30T12:00:00Z')}
      />
    ),
    agentCosts,
  ],
  [
    'skill costing',
    (client, grantKey) => <SkillCostingSection client={client} grantKey={grantKey} />,
    skillCosts,
  ],
];

const CROSSINGS = [
  ['another business', 'bravo', 'bravo:bea@example.test:0'],
  ['another person in the same business', 'alpha', 'alpha:bea@example.test:0'],
] as const;

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const CASES = VIEWS.flatMap(([view, draw, answer]) =>
  CROSSINGS.map(([crossing, business, grantKey]) => ({
    view,
    draw,
    answer,
    crossing,
    business,
    grantKey,
  })),
);

it.each(CASES)(
  "$view: drawn for $crossing, the earlier reader's late answer is never shown",
  async ({ draw, answer, business, grantKey }) => {
    const first = reader('alpha', answer('Alpha private marker'), true);
    mounted = await mount(draw(first.client, 'alpha:ada@example.test:0'));
    await tick();
    const next = reader(business, answer('Second reader marker'));
    await mounted.render(draw(next.client, grantKey));
    await tick();
    first.release();
    await tick();
    expect(mounted.text()).toContain('Second reader marker');
    expect(mounted.text()).not.toContain('Alpha private marker');
  },
);
