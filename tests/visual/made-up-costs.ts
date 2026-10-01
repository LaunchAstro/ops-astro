// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answer for what our agents cost us (SL13, MP-14-6): a month of runs,
// one unpriced and one the agency's own. Test side only, like made-up-api.ts,
// which answers with it. Every client and agent is made up.

import type { AgentCostsResult } from '../../packages/core-wire/src/index.ts';

export const AGENT_COSTS_READ: AgentCostsResult = {
  ok: true,
  period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
  runs: [
    {
      runId: 'r-1',
      taskId: 't-1',
      agentActorId: 'a-51f0c2d9',
      attachment: { kind: 'client', id: 'c-1', name: 'Meridian Dental' },
      currency: 'AUD',
      cost: '412',
      unpriced: null,
      startedAt: '2026-09-25T02:10:00.000Z',
      models: { ids: ['claude-opus-5-5'], unnamedCalls: 0 },
    },
    {
      runId: 'r-2',
      taskId: 't-2',
      agentActorId: 'a-51f0c2d9',
      attachment: { kind: 'agency' },
      currency: 'AUD',
      cost: null,
      unpriced: 'A call’s cost is not known yet: it is still running.',
      startedAt: '2026-09-25T04:30:00.000Z',
      models: { ids: ['claude-haiku-4-5-20251001'], unnamedCalls: 0 },
    },
  ],
  byAgent: [
    { agentActorId: 'a-51f0c2d9', currency: 'AUD', runs: 2, unpricedRuns: 1, total: '412' },
  ],
  byAttachment: [
    {
      attachment: { kind: 'client', id: 'c-1', name: 'Meridian Dental' },
      currency: 'AUD',
      runs: 1,
      unpricedRuns: 0,
      total: '412',
    },
    { attachment: { kind: 'agency' }, currency: 'AUD', runs: 1, unpricedRuns: 1, total: '0' },
  ],
};
