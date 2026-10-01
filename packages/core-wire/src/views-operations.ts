// SPDX-License-Identifier: AGPL-3.0-only
//
// What the operations view and its incident record answer (C55, C81), split out of `views.ts`
// when the main merge joined it past the product file limit. Types only, as there.

import type { UnattendedView } from './views.ts';

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
 * One security alert S0-2's forwarder raised, as the operations view lists it
 * (C55): its kind, the time it was raised (ISO 8601) and fixed plain
 * words for what it concerns; 'An alert of an unknown kind' for a kind the
 * view has no words for. Never an id, a secret or record content.
 */
export interface SecurityAlertView {
  readonly kind: string;
  readonly at: string;
  readonly concerns: string;
}

/**
 * `operations.read`'s answer (C55). The privacy incidents are this business's
 * own records. The service-health section (C34) is the installation's
 * watcher, error sink and optional tracing, read by the API after the grant
 * check and outside the serving transaction. The unattended items are INB-1's
 * own read (`inbox.unattended`'s answer). `operations.read` serves the
 * security alerts (S0-2) from the forwarder's log (0069), newest first, at
 * most 50, to the business that operates the installation alone; every other
 * business reads an empty list. The last tested restore (C55, carried from
 * S0-3) is the date a passed drill stamps (0070), served on every answer. The
 * API adds the error sink's web address, `OPS_ERROR_SINK_URL`, beside the
 * service-health section; each is its owner's read, placed here, never a
 * second copy.
 */
export interface OperationsReadResult {
  readonly ok: true;
  /** INB-1's unattended items whose task the caller reads: every path to a person broken. */
  readonly unattended: readonly UnattendedView[];
  readonly privacyIncidents: readonly PrivacyIncidentView[];
  /** What every incident record links to; `null` until a breach runbook is published. */
  readonly breachRunbook: BreachRunbookLink | null;
  /** Present on every answer the API serves; absent from a read made in-process. */
  readonly serviceHealth?: ServiceHealthSection;
  readonly securityAlerts?: readonly SecurityAlertView[];
  /**
   * The last tested restore a passed drill stamped (0070); `stale` past the
   * store's restore window or while no drill has passed.
   */
  readonly lastTestedRestore?: LastTestedRestoreView;
  /** The error sink's web address; `null` with none set; absent from an in-process read. */
  readonly errorSink?: { readonly url: string } | null;
}

/** The drill receipt's last successful tested restore (S0-3). */
export interface LastTestedRestoreView {
  /** ISO 8601, or null when no restore has been tested. */
  readonly at: string | null;
  /** The restore alert has fired since. */
  readonly stale: boolean;
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
