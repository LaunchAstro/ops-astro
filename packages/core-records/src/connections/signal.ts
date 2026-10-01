// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, sections 006 to 008 (MP-14-8): the grants live on the
// book, the tripwires watching, and the last night round in order.
//
// Every list is filtered by the scopes the caller holds `connection:read` at,
// inside its statement, as the fleet is. A business-wide reader sees every
// row. A client-scoped reader sees only the rows bound to one of their
// clients: a grant whose task carries that client, a tripwire or a step that
// names it. Fleet rows (no client) are not theirs, since a fleet lease or a
// fleet step reports on every client at once.
//
// A grant is a delegation (0008). Its client is its purpose task's party link
// (`uuid_7`, the slot a party-scoped grant resolves against). Its redemptions
// are the applied calls its agent made on that task while it held the
// delegation, less the pickup that minted it: the audit chain is the one
// record of them, and it cannot say what each call reached.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Scope } from '../authority/grants.ts';

export type GrantState = 'live' | 'ran_out' | 'taken_back';

export interface GrantRow {
  readonly id: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly string[];
  readonly clientId: string | null;
  readonly clientLabel: string | null;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
  readonly revocationCause: string | null;
  readonly state: GrantState;
  readonly redemptions: number;
}

export interface TripwireRow {
  readonly id: string;
  readonly what: string;
  readonly rule: string;
  readonly watching: string;
  readonly state: 'armed' | 'cannot_be_armed';
  readonly blockedReason: string | null;
  readonly firedCount: number;
  readonly lastFiredAt: Date | null;
  readonly filedItem: string | null;
  readonly filedNothing: string | null;
  readonly note: string | null;
}

export interface NightStepRow {
  readonly id: string;
  readonly at: Date;
  readonly tone: 'plain' | 'watch' | 'bad';
  readonly what: string;
  readonly who: string;
  readonly say: string;
  readonly citeKind: 'grants' | 'tripwires' | 'exceptions' | 'task' | null;
  readonly citeRef: string | null;
  readonly citeLabel: string | null;
}

export interface NightRound {
  readonly roundOn: string;
  readonly steps: readonly NightStepRow[];
}

export interface AgentRow {
  readonly id: string;
  readonly active: boolean;
}

interface Reach {
  readonly whole: boolean;
  readonly parties: readonly (string | null)[];
}

const reachOf = (scopes: readonly Scope[]): Reach => ({
  whole: scopes.some((scope) => scope.kind === 'business'),
  parties: scopes.filter((scope) => scope.kind === 'party').map((scope) => scope.id),
});

interface GrantDbRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly string[];
  readonly client_id: string | null;
  readonly client_label: string | null;
  readonly granted_at: Date;
  readonly expires_at: Date;
  readonly ended_at: Date | null;
  readonly revocation_cause: string | null;
  readonly state: GrantState;
  readonly redemptions: string;
}

/** The delegations these scopes may read, newest first within each state. */
export async function listGrants(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<readonly GrantRow[]> {
  const { whole, parties } = reachOf(scopes);
  const rows = await tx.query<GrantDbRow>(
    `with visible as (
       select d.*, t.uuid_7 as client_id,
              case when d.revoked_at is not null then 'taken_back'
                   when d.settled_at is not null or d.expires_at <= now() then 'ran_out'
                   else 'live' end as state
         from public.delegations d
         left join public.records t on t.id = d.purpose_scope_id
        where $1::boolean or t.uuid_7 = any($2::uuid[]))
     select v.id, v.agent_actor_id, v.purpose, v.collections, v.actions, v.client_id,
            (select cc.client_label from public.connection_clients cc
              where cc.client_id = v.client_id
              order by cc.client_label limit 1) as client_label,
            v.granted_at, v.expires_at, coalesce(v.revoked_at, v.settled_at) as ended_at,
            v.revocation_cause, v.state,
            (select count(*) from public.audit_events a
              where a.actor_id = v.agent_actor_id
                and a.subject_record_id = v.purpose_scope_id
                and a.outcome = 'applied'
                and a.command <> 'task.pickup'
                and a.occurred_at >= v.granted_at
                and a.occurred_at <= least(v.expires_at,
                                           coalesce(v.revoked_at, v.settled_at, 'infinity'))
            ) as redemptions
       from visible v
      order by case v.state when 'live' then 0 when 'ran_out' then 1 else 2 end,
               v.expires_at desc, v.id`,
    [whole, parties],
  );
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_actor_id,
    purpose: row.purpose,
    collections: row.collections,
    actions: row.actions,
    clientId: row.client_id,
    clientLabel: row.client_label,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    revocationCause: row.revocation_cause,
    state: row.state,
    redemptions: Number(row.redemptions),
  }));
}

interface TripwireDbRow {
  readonly id: string;
  readonly what: string;
  readonly rule: string;
  readonly watching: string;
  readonly state: 'armed' | 'cannot_be_armed';
  readonly blocked_reason: string | null;
  readonly fired_count: number;
  readonly last_fired_at: Date | null;
  readonly filed_item: string | null;
  readonly filed_nothing: string | null;
  readonly note: string | null;
}

/** The tripwires these scopes may read, armed first. */
export async function listTripwires(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<readonly TripwireRow[]> {
  const { whole, parties } = reachOf(scopes);
  const rows = await tx.query<TripwireDbRow>(
    `select id, what, rule, watching, state, blocked_reason, fired_count, last_fired_at,
            filed_item, filed_nothing, note
       from public.tripwires
      where $1::boolean or client_id = any($2::uuid[])
      order by state, what, id`,
    [whole, parties],
  );
  return rows.map((row) => ({
    id: row.id,
    what: row.what,
    rule: row.rule,
    watching: row.watching,
    state: row.state,
    blockedReason: row.blocked_reason,
    firedCount: row.fired_count,
    lastFiredAt: row.last_fired_at,
    filedItem: row.filed_item,
    filedNothing: row.filed_nothing,
    note: row.note,
  }));
}

interface StepDbRow {
  readonly id: string;
  readonly round_on: string;
  readonly at: Date;
  readonly tone: NightStepRow['tone'];
  readonly what: string;
  readonly who: string;
  readonly say: string;
  readonly cite_kind: NightStepRow['citeKind'];
  readonly cite_ref: string | null;
  readonly cite_label: string | null;
}

/**
 * The latest night round these scopes may read, its steps in time order, or
 * null when none has run. "Latest" is taken over the visible steps only, so a
 * client-scoped reader cannot learn that a later round ran for someone else.
 */
export async function readNightRound(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<NightRound | null> {
  const { whole, parties } = reachOf(scopes);
  const rows = await tx.query<StepDbRow>(
    `with visible as (
       select * from public.night_round_steps
        where $1::boolean or client_id = any($2::uuid[]))
     select id, to_char(round_on, 'YYYY-MM-DD') as round_on, at, tone, what, who, say,
            cite_kind, cite_ref, cite_label
       from visible
      where round_on = (select max(round_on) from visible)
      order by at, id`,
    [whole, parties],
  );
  const first = rows[0];
  if (first === undefined) return null;
  return {
    roundOn: first.round_on,
    steps: rows.map((row) => ({
      id: row.id,
      at: row.at,
      tone: row.tone,
      what: row.what,
      who: row.who,
      say: row.say,
      citeKind: row.cite_kind,
      citeRef: row.cite_ref,
      citeLabel: row.cite_label,
    })),
  };
}

/** The business's agent actors: the roster the grants' holders are drawn from. */
export async function listAgents(tx: TenantQuery): Promise<readonly AgentRow[]> {
  return await tx.query<AgentRow>(
    `select id, active from public.actors where kind = 'agent' order by created_at, id`,
  );
}
