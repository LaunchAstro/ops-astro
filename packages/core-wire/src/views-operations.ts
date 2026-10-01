// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view's read results (C55: privacy incidents, service health,
// breach notices), as they cross the wire. Types only, re-exported by
// `views.ts`, which holds every other read result.

/** One privacy incident record on the operations view (C55, SP-24). */
export interface PrivacyIncidentView {
  readonly id: string;
  readonly whatHappened: string;
  /** Day 0, ISO 8601. */
  readonly foundAt: string;
  readonly foundBy: string;
  readonly affected: string;
  readonly informationKinds: readonly string[];
  /** Day 0 plus 30 days: the runbook's assessment limit. */
  readonly assessBy: string;
  /** Still open past `assessBy`, judged on the database's clock (C81 breach drill). */
  readonly overdue: boolean;
  readonly status: 'open' | 'closed';
  readonly recordedAt: string;
  readonly recordedByActorId: string;
}

/** The breach runbook an incident record links to: the version published most recently (C81). */
export interface BreachRunbookLink {
  readonly version: string;
  readonly digest: string;
  readonly publishedAt: string;
  readonly body: string;
}

/** Where a service-health reading comes from (C34). */
export type HealthSourceName = 'watcher' | 'error-sink' | 'tracing';

/**
 * Whether a source could be read. `off` is an optional source switched off,
 * never a failure; `read-failure` says nothing about the services it watches.
 */
export type HealthSourceState = 'read' | 'read-failure' | 'off';

/** Why a source could not be read, by kind only: never the source's own words. */
export type HealthFault =
  'unconfigured' | 'refused' | 'malformed' | 'oversized' | 'slow' | 'unreachable';

/**
 * One service as its source last saw it. Four states kept apart: a service
 * never observed, one whose last observation is stale, one that failed, and
 * one that is healthy.
 */
export type ServiceHealthState = 'healthy' | 'service-failure' | 'stale' | 'never-observed';

export interface HealthSourceView {
  readonly source: HealthSourceName;
  readonly state: HealthSourceState;
  readonly fault: HealthFault | null;
}

export interface ServiceHealthView {
  readonly source: HealthSourceName;
  readonly name: string;
  readonly state: ServiceHealthState;
  /** ISO 8601, or null when never observed. */
  readonly lastObservedAt: string | null;
}

/** The service-health section of the operations view (C34). */
export interface ServiceHealthSection {
  readonly checkedAt: string;
  readonly sources: readonly HealthSourceView[];
  readonly services: readonly ServiceHealthView[];
}

/**
 * `operations.read`'s answer (C55). The privacy incidents are this business's
 * own records. The service-health section (C34) is the installation's
 * watcher, error sink and optional tracing, read by the API after the grant
 * check and outside the serving transaction. Unattended items (INB-1), security
 * alerts (S0-2) and the last tested restore (S0-3) join it as those parts
 * land; each is its owner's read, placed here, never a second copy.
 */
export interface OperationsReadResult {
  readonly ok: true;
  readonly privacyIncidents: readonly PrivacyIncidentView[];
  /** What every incident record links to; `null` until a breach runbook is published. */
  readonly breachRunbook: BreachRunbookLink | null;
  /** Present on every answer the API serves; absent from a read made in-process. */
  readonly serviceHealth?: ServiceHealthSection;
}

/** One notice the breach runbook's template drafts; nothing sends it (owner line 54). */
export interface BreachNoticeDraft {
  readonly to: 'oaic' | 'person';
  readonly name: string;
  readonly address: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * `privacy.draft_breach_notices`' answer (C81 breach drill): the runbook
 * version drafted from, and the notice to the OAIC first, then one per person.
 */
export interface BreachNoticesResult {
  readonly ok: true;
  readonly runbook: { readonly version: string; readonly digest: string };
  readonly notices: readonly BreachNoticeDraft[];
}
