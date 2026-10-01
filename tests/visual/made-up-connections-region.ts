// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for Connections & signal sections 009 to 012 (SL13):
// skill costing and the per-client region, after the mockup's skills and
// graduation rows. Beside `made-up-api.ts`, which serves them. Figures are
// minor units of AUD; every client, skill and sentence is made up.

import type {
  ConnectionGraduationResult,
  GraduationRowView,
  SkillCostsResult,
  SkillCostView,
} from '../../packages/core-wire/src/index.ts';

const DOC = { available: false, reason: 'Docs is not built yet (MP-7-6).' } as const;
const skill = (
  n: number,
  name: string,
  runs: { solo: number; shared: number; tasks: number },
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
  soloTotal: figure.kind === 'mean' ? String(Number(figure.mean) * runs.solo) : '0',
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
        { solo: 6, shared: 2, tasks: 5 },
        { kind: 'mean', mean: '184', lo: '61', hi: '356', finishedMean: '152' },
        ['claude-sonnet-5-5'],
      ),
      skill(
        2,
        'Negative-keyword sweep',
        { solo: 4, shared: 0, tasks: 4 },
        { kind: 'mean', mean: '47', lo: '31', hi: '72', finishedMean: null },
        ['claude-haiku-4-5-20251001'],
      ),
      skill(
        3,
        'Structured data build',
        { solo: 1, shared: 1, tasks: 2 },
        { kind: 'one', amount: '212' },
        ['claude-opus-5-5', 'claude-sonnet-5-5'],
      ),
      skill(4, 'Review reply drafting', { solo: 0, shared: 3, tasks: 2 }, { kind: 'none' }, [
        'claude-sonnet-5-5',
      ]),
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

const MERIDIAN = { id: 'c-meridian', label: 'Meridian Dental', scopes: ['ads.*', 'review.*'] };
const HARBOUR = { id: 'c-harbour', label: 'Harbourline Legal', scopes: ['ads.*', 'connector.*'] };
const grad = (
  n: number,
  row: Pick<GraduationRowView, 'actionClass' | 'classLabel' | 'clearance' | 'state' | 'note'> &
    Partial<GraduationRowView>,
): GraduationRowView => ({
  id: `g-${String(n)}`,
  clientId: MERIDIAN.id,
  heldBy: null,
  neverWhy: null,
  promotedAt: null,
  approved: 0,
  edited: 0,
  rejected: 0,
  since: null,
  revision: 1,
  ...row,
});

export const GRADUATION: ConnectionGraduationResult = {
  ok: true,
  clients: [MERIDIAN, HARBOUR],
  rows: [
    grad(1, {
      actionClass: 'review.chase.send',
      classLabel: 'Review chase',
      clearance: 'Draft',
      state: 'ready',
      approved: 47,
      since: '12 Jun',
      note: '47 approved, none edited, none rejected. A chase goes to the patient, not the practice.',
    }),
    grad(2, {
      actionClass: 'connector.resync',
      classLabel: 'Connector force resync',
      clearance: 'Observe',
      state: 'promoted',
      promotedAt: '2026-06-19T00:00:00.000Z',
      approved: 112,
      since: '03 Apr',
      note: 'A resync re-reads data we already hold permission to read.',
    }),
    grad(3, {
      actionClass: 'gbp.post.publish',
      classLabel: 'Google Business publish post',
      clearance: 'Configure',
      state: 'short',
      approved: 18,
      edited: 2,
      since: '21 May',
      note: 'Eighteen went clean and two were rewritten before they went.',
    }),
    grad(4, {
      actionClass: 'recommendation.send',
      classLabel: 'Client send recommendation',
      clearance: 'Draft',
      state: 'never',
      neverWhy: 'audience',
      approved: 23,
      edited: 4,
      since: '04 Mar',
      note: 'The client reads this one, so it never sends itself.',
    }),
    grad(5, {
      clientId: HARBOUR.id,
      actionClass: 'connector.resync',
      classLabel: 'Connector force resync',
      clearance: 'Observe',
      state: 'held',
      heldBy: 'a standing refusal',
      approved: 84,
      since: '11 Feb',
      note: 'Clears the bar and is held by the refusal below.',
    }),
  ],
  mandates: [
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      clientId: MERIDIAN.id,
      classes: ['ads.negative_keywords.add'],
      refuses: false,
      ceiling: { amountMinor: 50000, currency: 'AUD' },
      expiresAt: '2026-12-31T13:59:59.000Z',
      expired: false,
      label: 'Negative keywords may be added to the brand campaign without asking.',
      graduationClass: null,
      authoredBy: 'p-nathan-0000',
      createdAt: '2026-07-22T00:00:00.000Z',
      revision: 1,
    },
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000002',
      clientId: HARBOUR.id,
      classes: ['*'],
      refuses: true,
      ceiling: null,
      expiresAt: '2026-10-31T13:59:59.000Z',
      expired: false,
      label: 'Nothing at Harbourline runs unattended while the review is open.',
      graduationClass: null,
      authoredBy: 'p-mia-000000',
      createdAt: '2026-07-29T00:00:00.000Z',
      revision: 1,
    },
  ],
};
