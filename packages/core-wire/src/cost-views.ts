// SPDX-License-Identifier: AGPL-3.0-only
//
// What agent runs cost (U39): skill costing on Connections & signal (MP-14-9)
// and what our agents cost us (MP-14-6). Money is minor units as text, with
// its currency. A figure the product cannot give yet is a named field,
// unavailable with its reason, never left out and never a zero.

/** A field the product cannot fill yet, and why. */
export interface Unavailable {
  readonly available: false;
  readonly reason: string;
}

/**
 * A skill's cost: a mean only from more than one priced run, with its spread
 * and the mean of the finished ones when there are two; one priced run is
 * that run, never an average; none when no run of it has a known cost.
 */
export type SkillFigure =
  | {
      readonly kind: 'mean';
      readonly mean: string;
      readonly lo: string;
      readonly hi: string;
      readonly finishedMean: string | null;
    }
  | { readonly kind: 'one'; readonly amount: string }
  | { readonly kind: 'none' };

/** One skill that has run, in one currency. */
export interface SkillCostView {
  readonly skillId: string;
  readonly name: string;
  readonly currency: string;
  /** Every run pinned to one of its versions. */
  readonly runs: number;
  /** Of those, the runs that used this skill alone: the figure's evidence. */
  readonly soloRuns: number;
  /** Runs that used it beside another skill: counted, averaged into none. */
  readonly sharedRuns: number;
  /** Runs whose cost is not known yet: counted, in no figure. */
  readonly unpricedRuns: number;
  readonly tasks: number;
  readonly figure: SkillFigure;
  readonly soloTotal: string;
  /** The input and output split of its spend. */
  readonly usage: Unavailable;
  /** The exact model ids its runs called. */
  readonly models: Unavailable;
  /** Its process document at its canonical Docs address. */
  readonly document: Unavailable;
}

/** One attribution bucket: its runs and the priced spend they carry. */
export interface BucketView {
  readonly runs: number;
  readonly total: string;
}

/** Every run in exactly one bucket, so the three add back to the whole. */
export interface AttributionSplitView {
  readonly currency: string;
  readonly runs: number;
  readonly total: string;
  readonly solo: BucketView;
  readonly shared: BucketView;
  readonly unattributed: BucketView;
  readonly unpricedRuns: number;
}

/** `finance.skill_costs`: no costing at all when nothing the caller may see has run. */
export interface SkillCostsResult {
  readonly ok: true;
  readonly costing: {
    readonly skills: readonly SkillCostView[];
    readonly split: readonly AttributionSplitView[];
  } | null;
}

/** Whose work a run was: its task's client, else the agency's own. */
export type CostAttachment =
  | { readonly kind: 'client'; readonly id: string; readonly name: string | null }
  | { readonly kind: 'agency' };

/** One run of one agent in the cost log. */
export interface AgentCostRowView {
  readonly runId: string;
  readonly taskId: string;
  readonly agentActorId: string | null;
  readonly attachment: CostAttachment;
  readonly currency: string;
  /** Its priced spend, or null when a call's cost is not known yet. */
  readonly cost: string | null;
  /** Why it has no cost, when it has none. */
  readonly unpriced: string | null;
  readonly startedAt: string;
  readonly model: Unavailable;
}

/** Spend summed from the log's own rows. */
export interface CostTotalView {
  readonly currency: string;
  readonly runs: number;
  readonly unpricedRuns: number;
  readonly total: string;
}

/** `finance.agent_costs`: the cost log for a period, and its totals per agent and per client. */
export interface AgentCostsResult {
  readonly ok: true;
  readonly period: { readonly from: string; readonly to: string };
  readonly runs: readonly AgentCostRowView[];
  readonly byAgent: readonly (CostTotalView & { readonly agentActorId: string | null })[];
  readonly byAttachment: readonly (CostTotalView & { readonly attachment: CostAttachment })[];
}
