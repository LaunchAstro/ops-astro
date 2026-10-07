// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for what agent runs cost: skill costing on Connections &
// signal, after the mockup's skills, and a month of the Executive page's cost
// log, one run unpriced and one the agency's own. Beside `made-up-api.ts`,
// which serves them. Figures are minor units of AUD written as the server
// writes them; every client, skill and agent is made up.

import { FLEET_READ, SIGNAL_READ } from './made-up-connections.ts';
import type {
  AgentCostsResult,
  ConnectionFleetResult,
  ConnectionSignalResult,
  SkillCostsResult,
  SkillCostView,
} from '../../packages/core-wire/src/index.ts';

const DOC = { available: false, reason: 'Process documents open once Docs is built.' } as const;
const skill = (
  n: number,
  name: string,
  runs: { solo: number; shared: number; tasks: number; soloTotal: string },
  figure: SkillCostView['figure'],
  models: readonly string[],
): SkillCostView => ({
  skillId: `sk-${String(n)}`,
  name,
  currency: 'AUD',
  runs: runs.solo + runs.shared,
  soloRuns: runs.solo,
  sharedRuns: runs.shared,
  unpricedRuns: 0,
  tasks: runs.tasks,
  figure,
  soloTotal: runs.soloTotal,
  usage:
    figure.kind === 'mean'
      ? { measuredRuns: runs.solo, meanIn: '41200', meanOut: '6800' }
      : { measuredRuns: 0, meanIn: null, meanOut: null },
  models: { ids: models, unnamedCalls: 0 },
  document: DOC,
});

export const SKILL_COSTS: SkillCostsResult = {
  ok: true,
  costing: {
    skills: [
      skill(
        1,
        'Page copy rewrite',
        { solo: 6, shared: 2, tasks: 5, soloTotal: '1104' },
        { kind: 'mean', mean: '184', lo: '61', hi: '356', finishedMean: '152' },
        ['claude-sonnet-5-5'],
      ),
      skill(
        2,
        'Negative-keyword sweep',
        { solo: 4, shared: 0, tasks: 4, soloTotal: '188' },
        { kind: 'mean', mean: '47', lo: '31', hi: '72', finishedMean: null },
        ['claude-haiku-4-5-20251001'],
      ),
      skill(
        3,
        'Structured data build',
        { solo: 1, shared: 1, tasks: 2, soloTotal: '212' },
        { kind: 'one', amount: '212' },
        ['claude-opus-5-5', 'claude-sonnet-5-5'],
      ),
      skill(
        4,
        'Review reply drafting',
        { solo: 0, shared: 3, tasks: 2, soloTotal: '0' },
        { kind: 'none' },
        ['claude-sonnet-5-5'],
      ),
    ],
    split: [
      {
        currency: 'AUD',
        runs: 21,
        total: '3148',
        solo: { runs: 11, total: '1500' },
        shared: { runs: 6, total: '904' },
        unattributed: { runs: 4, total: '744' },
        unpricedRuns: 0,
      },
    ],
  },
};

export const AGENT_COSTS: AgentCostsResult = {
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

/** The Connections page's reads and the cost log, as the harness answers them. */
export const CONNECTION_READS: {
  readonly 'connection.fleet': ConnectionFleetResult;
  readonly 'connection.signal': ConnectionSignalResult;
  readonly 'finance.skill_costs': SkillCostsResult;
  readonly 'finance.agent_costs': AgentCostsResult;
} = {
  'connection.fleet': FLEET_READ,
  'connection.signal': SIGNAL_READ,
  'finance.skill_costs': SKILL_COSTS,
  'finance.agent_costs': AGENT_COSTS,
};
