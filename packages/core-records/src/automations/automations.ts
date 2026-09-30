// SPDX-License-Identifier: AGPL-3.0-only
//
// Automation definitions, released versions and activations (C33, U36;
// migration 0057). A version is written once and never changes; an activation
// is always pinned to one of its definition's versions, in a mode that version
// permits. The database holds each rule (the pin, the mode trigger and the
// immutability trigger); occurrences are in `occurrences.ts`.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

export type DefinitionKind = 'skill' | 'automation';
export type ActivationMode = 'manual' | 'scheduled' | 'event';

export interface DefinitionVersionRow {
  readonly id: string;
  readonly definitionId: string;
  readonly number: number;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly inputs: readonly unknown[];
  readonly operations: readonly unknown[];
  readonly modes: readonly ActivationMode[];
  readonly releasedByActorId: string;
}

export interface ActivationRow {
  readonly id: string;
  readonly definitionId: string;
  readonly versionId: string;
  readonly mode: ActivationMode;
  readonly everyMinutes: number | null;
  readonly eventKind: string | null;
  readonly enabled: boolean;
  readonly revision: number;
}

interface VersionDbRow {
  readonly id: string;
  readonly definition_id: string;
  readonly number: number;
  readonly content_digest: string;
  readonly content_size: string;
  readonly inputs: readonly unknown[];
  readonly operations: readonly unknown[];
  readonly modes: readonly ActivationMode[];
  readonly released_by_actor_id: string;
}

export interface ActivationDbRow {
  readonly id: string;
  readonly definition_id: string;
  readonly version_id: string;
  readonly mode: ActivationMode;
  readonly every_minutes: number | null;
  readonly event_kind: string | null;
  readonly enabled: boolean;
  readonly revision: string;
}

const VERSION_COLUMNS = `id, definition_id, number, content_digest, content_size, inputs, operations,
  modes, released_by_actor_id`;
export const ACTIVATION_COLUMNS = `id, definition_id, version_id, mode, every_minutes, event_kind, enabled,
  revision`;

const versionOf = (row: VersionDbRow): DefinitionVersionRow => ({
  id: row.id,
  definitionId: row.definition_id,
  number: row.number,
  contentDigest: row.content_digest,
  contentSize: Number(row.content_size),
  inputs: row.inputs,
  operations: row.operations,
  modes: row.modes,
  releasedByActorId: row.released_by_actor_id,
});

export const activationOf = (row: ActivationDbRow): ActivationRow => ({
  id: row.id,
  definitionId: row.definition_id,
  versionId: row.version_id,
  mode: row.mode,
  everyMinutes: row.every_minutes,
  eventKind: row.event_kind,
  enabled: row.enabled,
  revision: Number(row.revision),
});

export async function insertDefinition(
  tx: TenantQuery,
  definition: { readonly kind: DefinitionKind; readonly name: string; readonly actorId: string },
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.automation_definitions (business_id, id, kind, name, created_by_actor_id)
     values ((select public.app_business_id()), $1, $2, $3, $4)`,
    [id, definition.kind, definition.name, definition.actorId],
  );
  return id;
}

export interface VersionRelease {
  readonly definitionId: string;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly inputs: readonly unknown[];
  readonly operations: readonly unknown[];
  readonly modes: readonly ActivationMode[];
  readonly actorId: string;
}

/**
 * Releases the next version of a definition. Two releases racing on one
 * definition compute the same number; the database's uniqueness keeps one and
 * the other answers `raced`, to be asked again.
 */
export async function releaseVersion(
  tx: TenantQuery,
  release: VersionRelease,
): Promise<DefinitionVersionRow | 'raced' | null> {
  const rows = await tx.query<VersionDbRow>(
    `insert into public.definition_versions
       (business_id, id, definition_id, number, content_digest, content_size, inputs, operations,
        modes, released_by_actor_id)
     select d.business_id, $1, d.id,
            coalesce((select max(v.number) from public.definition_versions v
                       where v.definition_id = d.id), 0) + 1,
            $3, $4, $5::text::jsonb, $6::text::jsonb, $7, $8
       from public.automation_definitions d where d.id = $2
     on conflict on constraint definition_versions_number_once do nothing
     returning ${VERSION_COLUMNS}`,
    [
      randomUUID(),
      release.definitionId,
      release.contentDigest,
      release.contentSize,
      JSON.stringify(release.inputs),
      JSON.stringify(release.operations),
      release.modes,
      release.actorId,
    ],
  );
  if (rows[0] !== undefined) return versionOf(rows[0]);
  const known = await tx.query('select 1 from public.automation_definitions where id = $1', [
    release.definitionId,
  ]);
  return known.length === 0 ? null : 'raced';
}

export async function readVersion(
  tx: TenantQuery,
  versionId: string,
): Promise<DefinitionVersionRow | null> {
  const rows = await tx.query<VersionDbRow>(
    `select ${VERSION_COLUMNS} from public.definition_versions where id = $1`,
    [versionId],
  );
  return rows[0] === undefined ? null : versionOf(rows[0]);
}

export interface ActivationSetting {
  readonly versionId: string;
  readonly mode: ActivationMode;
  readonly everyMinutes: number | null;
  readonly eventKind: string | null;
  readonly enabled: boolean;
  readonly actorId: string;
}

/** A new activation on the definition its version belongs to. */
export async function insertActivation(
  tx: TenantQuery,
  setting: ActivationSetting,
): Promise<ActivationRow | null> {
  const rows = await tx.query<ActivationDbRow>(
    `insert into public.activations
       (business_id, id, definition_id, version_id, mode, every_minutes, event_kind, enabled,
        changed_by_actor_id)
     select v.business_id, $1, v.definition_id, v.id, $3, $4, $5, $6, $7
       from public.definition_versions v where v.id = $2
     returning ${ACTIVATION_COLUMNS}`,
    [
      randomUUID(),
      setting.versionId,
      setting.mode,
      setting.everyMinutes,
      setting.eventKind,
      setting.enabled,
      setting.actorId,
    ],
  );
  return rows[0] === undefined ? null : activationOf(rows[0]);
}

/**
 * Changes an activation at the revision the caller read. A stale revision
 * changes nothing and answers null; the pin stays on the same definition,
 * which the activation's foreign key holds.
 */
export async function changeActivation(
  tx: TenantQuery,
  activationId: string,
  expectedRevision: number,
  setting: ActivationSetting,
): Promise<ActivationRow | null> {
  const rows = await tx.query<ActivationDbRow>(
    `update public.activations
        set version_id = $3, mode = $4, every_minutes = $5, event_kind = $6, enabled = $7,
            changed_by_actor_id = $8, changed_at = now(), revision = revision + 1
      where id = $1 and revision = $2
      returning ${ACTIVATION_COLUMNS}`,
    [
      activationId,
      expectedRevision,
      setting.versionId,
      setting.mode,
      setting.everyMinutes,
      setting.eventKind,
      setting.enabled,
      setting.actorId,
    ],
  );
  return rows[0] === undefined ? null : activationOf(rows[0]);
}

export async function readActivation(
  tx: TenantQuery,
  activationId: string,
): Promise<ActivationRow | null> {
  const rows = await tx.query<ActivationDbRow>(
    `select ${ACTIVATION_COLUMNS} from public.activations where id = $1`,
    [activationId],
  );
  return rows[0] === undefined ? null : activationOf(rows[0]);
}
