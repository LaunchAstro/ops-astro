// SPDX-License-Identifier: AGPL-3.0-only
//
// The promotion step (ticket S0-1, S0-1d). Stub: the named tests are written
// first and shown red against it.

/** A service as the service manager names it. */
export interface ServiceRef {
  manager: 'docker' | 'launchd';
  name: string;
}

/** What the service manager says about one service. */
export interface ServiceState extends ServiceRef {
  running: boolean;
}

/** What the promotion records: the version and the owner's one line. */
export interface PromotionRecord {
  action: 'promotion recorded';
  version: string;
  artefact: string;
  line: string;
  dryRun: boolean;
}

export interface PromotionRequest {
  version: string;
  store: string;
  line: string;
  dryRun: boolean;
  api?: ServiceRef;
  auth?: ServiceRef;
  current?: string;
}

/** Everything the step does to the machine, so a test can watch it. */
export interface PromotionEffects {
  services(): readonly ServiceState[];
  migrate(): boolean;
  point(current: string, artefact: string): void;
  start(service: ServiceRef): void;
}

export type PromotionOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'dry-run' | 'promoted'; record: PromotionRecord; artefactPath: string };

/** Parse `docker:<name>` or `launchd:<label>`. */
export function parseService(_text: string): ServiceRef {
  throw new Error('parseService: not built yet');
}

export function promote(_request: PromotionRequest, _effects: PromotionEffects): PromotionOutcome {
  throw new Error('promote: not built yet');
}
