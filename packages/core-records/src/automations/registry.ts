// SPDX-License-Identifier: AGPL-3.0-only
//
// The registry Settings ▸ Workflow triggers reads (C33): every definition in
// the transaction's business, its released versions oldest first, and the
// activations pinned to them, each with the standing approval it names (C52-A).
// Row security keeps each statement to the one business; no row carries a
// client, so nothing here filters by client.

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
  /** The standing approval the activation names (C52-A), revoked or not, or null. */
  readonly approval: RegistryApproval | null;
}

export interface RegistryApproval {
  readonly id: string;
  readonly versionId: string;
  readonly act: 'adopted' | 'rolled_back';
  readonly decidedBy: string;
  readonly revoked: boolean;
}

export interface Registry {
  readonly definitions: readonly RegistryDefinition[];
  readonly versions: readonly RegistryVersion[];
  readonly activations: readonly RegistryActivation[];
}

export async function listRegistry(tx: TenantQuery): Promise<Registry> {
  const definitions = await tx.query<RegistryDefinition>(
    `select id, kind, name from public.automation_definitions order by created_at, id`,
  );
  // Both counts are cast in the statement, so each row is read as it comes.
  const versions = await tx.query<RegistryVersion>(
    `select id, definition_id as "definitionId", number, content_digest as "contentDigest",
            content_size::float8 as "contentSize", modes, released_by_actor_id as "releasedBy",
            to_char(released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "releasedAt"
       from public.definition_versions order by definition_id, number`,
  );
  const activations = await tx.query<RegistryActivation>(
    `select a.id, a.definition_id as "definitionId", a.version_id as "versionId",
            v.number as "versionNumber", a.mode, a.every_minutes as "everyMinutes",
            a.event_kind as "eventKind", a.enabled, a.changed_by_actor_id as "changedBy",
            to_char(a.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "changedAt",
            a.revision::float8 as revision,
            case when s.id is null then null else json_build_object(
              'id', s.id, 'versionId', s.version_id, 'act', s.act,
              'decidedBy', s.decided_by_actor_id,
              'revoked', exists (select 1 from public.standing_approval_revocations r
                                  where r.approval_id = s.id)) end as approval
       from public.activations a
       join public.definition_versions v on v.id = a.version_id
       left join public.standing_approvals s on s.id = a.approval_id
      order by a.definition_id, a.id`,
  );
  return { definitions, versions, activations };
}
