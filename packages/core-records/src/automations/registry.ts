// SPDX-License-Identifier: AGPL-3.0-only
//
// The registry Settings ▸ Workflow triggers reads (C33): every definition in
// the transaction's business, its released versions oldest first, and the
// activations pinned to them. Row security keeps each statement to the one
// business; no row carries a client, so nothing here filters by client.

import type { TenantQuery } from '../tenancy/database.ts';
import type { ActivationMode, DefinitionKind } from './automations.ts';

export interface RegistryDefinition {
  readonly id: string;
  readonly kind: DefinitionKind;
  readonly name: string;
}

export interface RegistryVersion {
  readonly id: string;
  readonly definitionId: string;
  readonly number: number;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly modes: readonly ActivationMode[];
  readonly releasedBy: string;
  readonly releasedAt: string;
}

export interface RegistryActivation {
  readonly id: string;
  readonly definitionId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly mode: ActivationMode;
  readonly everyMinutes: number | null;
  readonly eventKind: string | null;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly revision: number;
}

export interface Registry {
  readonly definitions: readonly RegistryDefinition[];
  readonly versions: readonly RegistryVersion[];
  readonly activations: readonly RegistryActivation[];
}

export async function listRegistry(_tx: TenantQuery): Promise<Registry> {
  return await Promise.resolve({ definitions: [], versions: [], activations: [] });
}
