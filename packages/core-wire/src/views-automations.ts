// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers' read result (C33), as it crosses the wire.
// Types only, beside `views.ts`, which is at its line cap.

/**
 * Each definition with its released versions, oldest first, and the
 * activations pinned to them. Definitions carry no client, so the registry is
 * the business's and nothing in it is filtered by client.
 */
export interface AutomationRegistryResult {
  readonly ok: true;
  readonly definitions: readonly AutomationDefinitionView[];
}

export interface AutomationDefinitionView {
  readonly id: string;
  readonly kind: 'skill' | 'automation';
  readonly name: string;
  readonly versions: readonly DefinitionVersionView[];
  readonly activations: readonly ActivationView[];
}

export interface DefinitionVersionView {
  readonly id: string;
  readonly number: number;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly modes: readonly ('manual' | 'scheduled' | 'event')[];
  readonly releasedBy: string;
  readonly releasedAt: string;
}

export interface ActivationView {
  readonly id: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly mode: 'manual' | 'scheduled' | 'event';
  readonly everyMinutes: number | null;
  readonly eventKind: string | null;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly revision: number;
}
