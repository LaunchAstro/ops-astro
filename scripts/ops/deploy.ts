// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging deploy (ticket S0-6). Not built yet: the tests come first.

/** The staging definition, as the deploy reads it. */
export interface StagingDefinition {
  'x-ops-astro': { ownPrefix: string; artefact: string; appServices?: string[] };
  services: Record<string, { container_name?: string; image?: unknown; [key: string]: unknown }>;
}

export const APP_IMAGE_PLACEHOLDER =
  '${OPS_ASTRO_STAGING_APP_IMAGE:?set by scripts/ops/deploy.mjs}';

export interface DeployEffects {
  snapshot(): string;
  compare(before: string, after: string): { unchanged: boolean; report: string };
  buildImage(artefactPath: string): string;
  up(appImage: string): void;
  imageId(ref: string): string | undefined;
  runningImages(): Record<string, string>;
}

export type DeployOutcome =
  | { kind: 'refused' | 'failed'; reason: string }
  | { kind: 'deployed'; record: Record<string, unknown> };

export function imagePinProblems(_definition: StagingDefinition, _record: string): string[] {
  return [];
}

export function deploy(
  _request: { version: string; store: string },
  _effects: DeployEffects,
): DeployOutcome {
  return { kind: 'refused', reason: 'not built' };
}
