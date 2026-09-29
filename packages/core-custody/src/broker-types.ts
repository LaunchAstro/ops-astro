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
  RouteReach,
} from '../../core-connectors/src/index.ts';
import type { CarryRefusal, CredentialKind } from './credentials.ts';
import type { Custody } from './custody.ts';

/** How a provider's adapter builds a request and prices an answer. It runs here, never in custody. */
export interface ProviderAdapter {
  readonly build: (values: Readonly<Record<string, string>>) => AdapterRequest;
  readonly price: (answer: ModelAnswer) => number;
}

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
    'model.call_dispatched' | 'model.call_released' | 'model.call_refused' | 'model.call_held';
  readonly outcome: 'applied' | 'refused';
  /** Set on a refusal, from the refusal register. */
  readonly refusalCode: BrokerRefusal | 'LIABILITY_UNKNOWN' | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface Broker {
  readonly custody: Custody;
  readonly operations: ReadonlyMap<string, ModelOperation>;
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
  readonly routes: readonly BrokerRoute[];
  readonly installation: string;
  /** Written by the command layer inside the settling transaction. */
  readonly audit: (tx: TenantQuery, note: AuditNote) => Promise<void>;
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
}

export interface ModelCallRequest {
  readonly leaseId: string;
  readonly fence: number;
  readonly stepId: string;
  readonly operation: string;
  readonly fields: readonly ModelCallField[];
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
  | CarryRefusal;

export type ModelCallResult =
  | {
      readonly ok: true;
      readonly callId: string;
      readonly text: string;
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
    }
  | {
      readonly ok: false;
      readonly code: 'LIABILITY_UNKNOWN';
      readonly callId: string;
      readonly heldMinor: number;
      readonly observedMinor: number | null;
      readonly drop: 'dropped_worker_lost' | 'dropped_no_answer' | null;
    }
  | {
      readonly ok: false;
      readonly code: 'CALL_RELEASED';
      readonly callId: string;
      readonly reason: string;
    };
