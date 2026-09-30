// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 on the execution graph: the helpers a run's work was handed to, under
// that run's node (`execution-graph.ts`).
//
// A helper is a child delegation of one of the run's leases' delegations, so
// the parent that handed the work over and a replacement parent that picked
// the work up again each show their own helpers on the one node. Each entry
// carries the helper, its standing by the rule the parent's merged result
// uses (`childStateOf`: handed back, else dropped with its fault, else
// working), and its steps: the model calls it made on the parent's lease,
// which spend the parent's one reservation (d71424f), so the node's money is
// already the whole of it. A step is the call's own row, found by the
// caller's delegation the broker records (0060), never by time or actor.
//
// Read in `execution.ts`'s one statement, so a helper's handback counts only
// at or before the event head the page stops at.

import { childStateOf, type ChildResult } from '../../../core-runtime/src/index.ts';

export interface HelperStep {
  readonly callId: string;
  readonly operation: string;
  readonly state: string;
  readonly reservedMinor: number;
  /** What the call settled at; null until it settles. */
  readonly spentMinor: number | null;
}

/** A step on the graph: it takes its parent run's placement (ORCH42 decision (a)). */
export interface PlacedStep extends HelperStep {
  /** The parent run's plan step, or null. */
  readonly planned: { readonly key: string; readonly title: string } | null;
  /** Whether the parent run's node reads `unplanned`. */
  readonly unplanned: boolean;
}

export interface HelperEntry<S extends HelperStep = HelperStep> extends Pick<
  ChildResult,
  'state' | 'outcome' | 'refusal' | 'fault'
> {
  readonly childDelegationId: string;
  readonly helperActorId: string;
  /** The helper's settled spend on the parent's reservation; null for none. */
  readonly spentMinor: number | null;
  readonly steps: readonly S[];
}

/**
 * Each helper of the run `run` as JSON, for `execution.ts`'s run facts. `$1`
 * is the business; `head` is the statement's own event head.
 */
export const HELPER_FACTS = `coalesce((select json_agg(json_build_object(
    'childDelegationId', d.id, 'helperActorId', d.agent_actor_id,
    'expired', d.expires_at <= now(), 'revoked', d.revoked_at is not null,
    'cause', d.revocation_cause,
    'outcome', back.detail ->> 'outcome', 'refusal', back.detail ->> 'refusal',
    'steps', coalesce((select json_agg(json_build_object(
        'callId', c.id, 'operation', c.operation_key, 'state', c.state,
        'reservedMinor', c.reserved_minor::float8, 'spentMinor', c.actual_minor::float8)
        order by c.accepted_at, c.id)
      from public.model_calls c
      where c.business_id = $1 and c.run_id = run.id and c.caller_delegation_id = d.id), '[]'))
    order by d.granted_at, d.id)
  from public.delegations d
  join public.leases pl
    on pl.business_id = d.business_id and pl.delegation_id = d.parent_delegation_id
  left join lateral (select ev.detail from public.run_events ev
      where ev.business_id = $1 and ev.run_id = run.id and ev.kind = 'child_handed_back'
        and ev.detail ->> 'childDelegationId' = d.id::text
        and ev.position <= (select n from head)
      limit 1) back on true
 where d.business_id = $1 and pl.run_id = run.id), '[]')`;

const OUTCOMES: ReadonlySet<unknown> = new Set([null, 'completed', 'partial']);

/** The run facts' `helpers`, checked and read into entries; a malformed one throws. */
export function helpersOf(value: unknown, where: string): readonly HelperEntry[] {
  if (!Array.isArray(value)) throw new Error(`${where}: the helpers are not a list`);
  return value.map((helper: unknown, index) => {
    const at = `${where}: helper ${String(index)}`;
    if (
      !isRecord(helper) ||
      typeof helper['childDelegationId'] !== 'string' ||
      typeof helper['helperActorId'] !== 'string' ||
      typeof helper['expired'] !== 'boolean' ||
      typeof helper['revoked'] !== 'boolean' ||
      !nullOrString(helper['cause']) ||
      !OUTCOMES.has(helper['outcome']) ||
      !nullOrString(helper['refusal'])
    )
      throw new Error(`${at} is malformed`);
    const steps = stepsOf(helper['steps'], at);
    const settled = steps.filter((step) => step.spentMinor !== null);
    return {
      childDelegationId: helper['childDelegationId'],
      helperActorId: helper['helperActorId'],
      ...childStateOf({
        expired: helper['expired'],
        revoked: helper['revoked'],
        cause: helper['cause'] as string | null,
        outcome: helper['outcome'] as 'completed' | 'partial' | null,
        refusal: helper['refusal'] as string | null,
      }),
      spentMinor:
        settled.length === 0
          ? null
          : settled.reduce((sum, step) => sum + (step.spentMinor ?? 0), 0),
      steps,
    };
  });
}

function stepsOf(value: unknown, where: string): readonly HelperStep[] {
  if (!Array.isArray(value)) throw new Error(`${where}: the steps are not a list`);
  return value.map((step: unknown, index) => {
    if (
      !isRecord(step) ||
      typeof step['callId'] !== 'string' ||
      typeof step['operation'] !== 'string' ||
      typeof step['state'] !== 'string' ||
      !isMinor(step['reservedMinor']) ||
      !(step['spentMinor'] === null || isMinor(step['spentMinor']))
    )
      throw new Error(`${where}: step ${String(index)} is malformed`);
    return step as unknown as HelperStep;
  });
}

function isMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullOrString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
