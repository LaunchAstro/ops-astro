// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's shapes (AW-01): the route, the caller, the request and every
// answer a model call can give. The steps are in broker.ts.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type {
  AdapterRequest,
  FieldSource,
  ModelAnswer,
  ModelOperation,
  ModelToolCall,
  RouteReach,
} from '../../core-connectors/src/index.ts';
import type { CarryRefusal } from './carry-rule.ts';
import type { CredentialKind } from './credentials.ts';
import type { Custody } from './custody.ts';

/**
 * How a provider's adapter builds a request and prices an answer. It runs
 * here, never in custody. The call's id is the operation id the provider is
 * given, so the reconciliation pass can ask about it later (AW-10): `lookup`
 * builds that question and `readLookup` reads the one code it answers. An
 * adapter with no lookup leaves every unknown call to a person.
 */
export interface ProviderAdapter {
  readonly build: (
    values: Readonly<Record<string, string>>,
    operationId?: string,
    /** The exact model to ask for (CS-7.30); absent, the provider's default. */
    model?: string,
    /** Ask for the answer as a stream: only where custody presents no credential. */
    streamed?: boolean,
  ) => AdapterRequest;
  readonly price: (answer: ModelAnswer) => number;
  /** The most bytes a built request's body may hold; a paid call above it is refused before its hold. */
  readonly bodyLimit?: number;
  readonly lookup?: (operationId: string) => AdapterRequest;
  readonly readLookup?: (body: unknown) => string | undefined;
}

/**
 * AW-10: which drop a held call was. The provider said it is down or
 * limiting; the connection was cut with no answer; or our side was lost.
 */
export type DropCause = 'provider_unavailable' | 'connection_lost' | 'worker_lost';

/** Whose fault a failure was, from the evidence; `undetermined` when it cannot say. */
export type CallFault = 'provider' | 'network' | 'ours' | 'undetermined';

/** A configured route: where a call may go, and which credential custody carries it with. */
export interface BrokerRoute {
  readonly key: string;
  readonly reach: RouteReach;
  readonly provider: string;
  readonly credentialRef: string;
  readonly credentialKind: CredentialKind;
  /** The installation whose credential this is. */
  readonly installation: string;
  /**
   * The calls in flight on this route across every business of the
   * installation, at most; a business with work in flight holds no more than
   * its share of it (AW-01's fair share).
   */
  readonly ceiling: number;
}

/**
 * One audit event, written by the command layer in the settling transaction.
 * An applied event carries only the digest of its detail; a refusal carries
 * the detail itself (the observed amount, for one above the hold).
 */
export interface AuditNote {
  readonly action:
    | 'model.call_dispatched'
    | 'model.call_released'
    | 'model.call_refused'
    | 'model.call_held'
    // A paid answer whose call another writer had already ended: no money moved, nothing kept.
    | 'model.call_settle_lost';
  readonly outcome: 'applied' | 'refused';
  /** Set on a refusal, from the refusal register. */
  readonly refusalCode: BrokerRefusal | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The deployment's carrier: its model agent, and the people it carries calls for. */
export interface Carrier {
  readonly agent: string;
  readonly people: readonly string[];
}

export interface Broker {
  readonly custody: Custody;
  readonly operations: ReadonlyMap<string, ModelOperation>;
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
  readonly routes: readonly BrokerRoute[];
  readonly installation: string;
  /**
   * LA-1's local carve-out (#859): set by the API's composition root only
   * where it accepted `OPS_AGENT_PROVIDER=local-gpt` under
   * `OPS_ENVIRONMENT=local`. It reaches `mayCarry` only for a `local_gpt` route.
   */
  readonly localOwnerTesting?: boolean;
  /**
   * `OPS_OUTSIDE_MODEL_PEOPLE` (#1508): the `businessId:personId` pairs whose own
   * typed words may go to the outside paid route (`carriesOutside`). Absent or
   * empty, nobody's do.
   */
  readonly outsidePeople?: readonly string[];
  /**
   * `OPS_HERMES_PEOPLE` (#2270): the `businessId:personId` pairs Hermes Agent
   * answers (`hermesStanding`). Absent or empty, it answers nobody.
   */
  readonly hermesPeople?: readonly string[];
  /** `MODEL_BROKER_CARRIER`'s agent (#1531): each call carried by it, from a conversation it is in. */
  readonly carrier?: Carrier;
  /** Written by the command layer inside the settling transaction. */
  readonly audit: (tx: TenantQuery, note: AuditNote) => Promise<void>;
  /**
   * T3e1's drop at settlement, given by the command layer (#1623 R1): called
   * before the settlement's own locks for a provider drop the worker could
   * report, it takes its locks and returns the writer the stop calls last.
   */
  /**
   * The calls a run attempt may make (#1623 R3); absent, `AGENT_MODEL_CALL_LIMIT`.
   * Its first hold records it, so a change mid-attempt never raises it.
   */
  readonly callLimit?: number;
  readonly drops?: (
    tx: TenantQuery,
    leaseId: string,
  ) => Promise<((cause: DropCause) => Promise<void>) | undefined>;
}

/**
 * A field the caller supplies, with its statement of where the value came
 * from. The statement only narrows: a claimed `business_internal` is treated
 * as `outside` (S3), because only the broker can find a source internal.
 */
export interface ClaimedField {
  readonly name: string;
  readonly source: FieldSource;
  readonly value: string;
}

/** A field bound to the row it is read from: the broker reads the value and finds the source. */
export interface BoundField {
  readonly name: string;
  readonly from: { readonly recordId: string; readonly key: string };
}

export type ModelCallField = ClaimedField | BoundField;

/** A field as the broker acts on it: its value, and the source the broker found. */
export interface ResolvedField {
  readonly name: string;
  readonly source: FieldSource;
  readonly value: string;
  /** The broker found it the owner's own work, with no client in it (owner line 72). */
  readonly ownerWork?: boolean;
}

/** What a paid call asks of the caller, inside a transaction opened as them. */
export interface PaidCaller {
  /** After the call's own lock: whether the send still rests on live facts. */
  readonly stillAdmitted: () => Promise<boolean>;
  /** Keeps the answer as the reply, in the settling transaction; false when it cannot be. */
  readonly keep: (text: string) => Promise<boolean>;
}

export interface PaidSeams {
  /** Who wrote each person turn the call sends: the asked message and the earlier ones. */
  readonly authors: readonly string[];
  /**
   * Runs `work` in a transaction as the caller, resolved again from their
   * session; undefined when they cannot be, or a lock they need is held elsewhere.
   */
  readonly asCaller: <T>(
    work: (tx: TenantQuery, caller: PaidCaller) => Promise<T>,
  ) => Promise<T | undefined>;
}

/** A turn as the body sent it, read by the broker's bounded parsers (`broker-turn.ts`). */
export interface TurnRequest {
  readonly turnOrdinal: unknown;
  readonly tools: unknown;
  readonly parts: unknown;
}

export interface ModelCallRequest {
  readonly leaseId: string;
  readonly fence: number;
  readonly stepId: string;
  readonly operation: string;
  readonly fields: readonly ModelCallField[];
  /** A model turn (#1623 R3), for an operation that takes one; its fields are then none. */
  readonly turn?: TurnRequest;
}

/** Who is calling, from the authenticated envelope, never the body. */
export interface ModelCaller {
  readonly actorId: string;
  /** The delegation the envelope resolved for this call, or none for a person's own lease. */
  readonly delegationId: string | null;
  /** The person present in their own session for this call, or none for unattended work. */
  readonly attendedByPersonId: string | null;
}

export type BrokerRefusal =
  | 'LEASE_NOT_OWNED'
  | 'LEASE_EXPIRED'
  | 'DECISION_STALE'
  | 'AUTHORITY_LOST'
  | 'OPERATION_NOT_CATALOGUED'
  | 'EFFECT_NOT_RECONCILABLE'
  | 'LOCAL_MODEL_REQUIRED'
  | 'CLIENT_MODEL_USE_OFF'
  | 'SOURCE_UNREADABLE'
  | 'BUDGET_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'COPY_NOT_REGISTERED'
  | 'LIABILITY_UNKNOWN'
  // #1531: the message's one call is on its way or ended; the carrier is no member.
  | 'STILL_ANSWERING'
  | 'ANSWER_ENDED'
  | 'CARRIAGE_UNAVAILABLE'
  // #1508: a paid request past its destination's size; the send no longer admitted at the handoff.
  | 'PROMPT_TOO_LARGE'
  | 'CUSTODY_NOT_ADMITTED'
  // #1623 R3: the attempt's calls at its limit; a turn out of shape, out of order or unbound.
  | 'CALL_LIMIT_REACHED'
  | 'TURN_MALFORMED'
  | 'TURN_ORDINAL_STALE'
  | 'PROVENANCE_UNBOUND'
  | CarryRefusal;

export type ModelCallResult =
  | {
      readonly ok: true;
      readonly callId: string;
      readonly text: string;
      /** A turn's tools asked for, in the provider's order. */
      readonly toolCalls?: readonly ModelToolCall[];
      /** The call that reached its attempt's limit: its settlement ended the attempt. */
      readonly terminal?: 'call_limit';
      readonly reservedMinor: number;
      readonly actualMinor: number;
      readonly releasedMinor: number;
    }
  | {
      readonly ok: false;
      readonly code: BrokerRefusal;
      /** The recorded step, when the refusal was recorded as one. */
      readonly callId: string | null;
      readonly words?: string;
      readonly retryAfterSeconds?: number;
      /** What the allowance has left, on a paid call refused for want of room. */
      readonly leftMinor?: number;
    }
  | {
      readonly ok: false;
      readonly code: 'LIABILITY_UNKNOWN';
      readonly callId: string;
      readonly heldMinor: number;
      readonly observedMinor: number | null;
      readonly drop: 'dropped_worker_lost' | 'dropped_no_answer' | null;
      /** AW-10: which drop, or null for a failure that is no drop. */
      readonly cause: DropCause | null;
      readonly fault: CallFault;
      /** The provider's refusal code, or null when none arrived. */
      readonly providerCode: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'CALL_RELEASED';
      readonly callId: string;
      readonly reason: string;
    };
