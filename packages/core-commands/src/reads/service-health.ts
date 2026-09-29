// SPDX-License-Identifier: AGPL-3.0-only
//
// The service-health section of the operations view (C34).

import type { HealthFault, ServiceHealthSection } from '../../../core-wire/src/index.ts';

/** One service as a source reports it. */
export interface ServiceObservation {
  readonly name: string;
  /** A client's own site is that client's, never the installation's (C24). */
  readonly scope: 'installation' | 'client-site';
  /** Up or down at the last check, or null when never checked. */
  readonly up: boolean | null;
  readonly observedAt: Date | null;
}

export type SourceAnswer =
  | { readonly ok: true; readonly services: readonly ServiceObservation[] }
  | { readonly ok: false; readonly fault: Exclude<HealthFault, 'unconfigured'> };

/** A watcher, an error sink or the tracing service, as the operations view reads it. */
export interface HealthSource {
  observe(): Promise<SourceAnswer>;
}

/** The installation's sources. An absent `tracing` is switched off. */
export interface HealthSources {
  readonly watcher?: HealthSource;
  readonly errorSink?: HealthSource;
  readonly tracing?: HealthSource;
  readonly timeoutMs?: number;
}

/** A service last seen longer ago than this is stale: three of the watcher's five-minute checks. */
export const HEALTH_STALE_SECONDS: number = 15 * 60;

export async function readServiceHealth(
  _sources: HealthSources,
  _now: Date,
): Promise<ServiceHealthSection> {
  throw new Error('C34: not built');
}
