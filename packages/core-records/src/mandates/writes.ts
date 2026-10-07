// SPDX-License-Identifier: AGPL-3.0-only
//
// The reads and writes behind graduation and standing mandates (MP-14-10a).
// `lockClientForWrite`, `lockGraduationClass` and `lockMandate` take the row
// locks a command serialises on; the other reads run unlocked, before or under
// those locks, by design. A mandate is filed and revoked, never edited; a
// graduation row has its revision bumped by a promote, a demote, or the revoke
// of the mandate that promoted it. Times are the database's clock
// (`clock_timestamp()`), read in the statement that writes, after any lock
// wait, never the transaction's start or a time handed in.
//
// Every writer locks in core's order: the client's row first (for no key update,
// `lockClientForWrite`), then the graduation row, then the mandate. A writer
// that starts from a class or a mandate reads its client unlocked first
// (`clientOfClass`, `clientOfMandate`; a row's client never changes), so no
// writer ever holds a later lock while it waits for an earlier one.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  MANDATE_COLUMNS,
  classOf,
  mandateOf,
  type ClassDbRow,
  type GraduationClassRow,
  type MandateDbRow,
  type MandateRow,
} from './mandates.ts';

/** The client's row, locked as every mandate writer takes it first; false when not this business's. */
export async function lockClientForWrite(tx: TenantQuery, clientId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select k.id from public.clients k
      where k.business_id = (select public.app_business_id()) and k.id = $1
      for no key update`,
    [clientId],
  );
  return rows.length === 1;
}

/** The client a graduation row is about, read unlocked; null when not this business's. */
export async function clientOfClass(tx: TenantQuery, classId: string): Promise<string | null> {
  const rows = await tx.query<{ readonly client_id: string }>(
    `select g.client_id from public.graduation_classes g
      where g.business_id = (select public.app_business_id()) and g.id = $1`,
    [classId],
  );
  return rows[0]?.client_id ?? null;
}

/** The client a mandate is for, read unlocked; null when not this business's. */
export async function clientOfMandate(tx: TenantQuery, mandateId: string): Promise<string | null> {
  const rows = await tx.query<{ readonly client_id: string }>(
    `select m.client_id from public.standing_mandates m
      where m.business_id = (select public.app_business_id()) and m.id = $1`,
    [mandateId],
  );
  return rows[0]?.client_id ?? null;
}

/** A locked graduation row with its client's name, which a promotion's label carries. */
export type LockedGraduationClass = GraduationClassRow & { readonly clientLabel: string };

/** One graduation row, locked for the promote or demote that moves it; null when not this business's. */
export async function lockGraduationClass(
  tx: TenantQuery,
  classId: string,
): Promise<LockedGraduationClass | null> {
  const rows = await tx.query<ClassDbRow & { readonly client_label: string }>(
    `select g.id, g.client_id, k.name as client_label, g.action_class, g.class_label, g.clearance,
            g.earned, g.never_why, g.approved, g.edited, g.rejected, g.since::text as since, g.note,
            g.revision
       from public.graduation_classes g
       join public.clients k on k.business_id = g.business_id and k.id = g.client_id
      where g.business_id = (select public.app_business_id()) and g.id = $1
      for no key update of g`,
    [classId],
  );
  const row = rows[0];
  return row === undefined ? null : { ...classOf(row), clientLabel: row.client_label };
}

/** Steps a graduation row's revision by one; its new revision. */
export async function bumpGraduationClass(tx: TenantQuery, classId: string): Promise<number> {
  const rows = await tx.query<{ readonly revision: string }>(
    `update public.graduation_classes set revision = revision + 1
      where business_id = (select public.app_business_id()) and id = $1
      returning revision`,
    [classId],
  );
  return Number(rows[0]?.revision);
}

/** The client's own action classes, from which its scope list is built. */
export async function clientClasses(tx: TenantQuery, clientId: string): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly action_class: string }>(
    `select action_class from public.graduation_classes
      where business_id = (select public.app_business_id()) and client_id = $1`,
    [clientId],
  );
  return rows.map((row) => row.action_class);
}

export interface MandateFiling {
  readonly clientId: string;
  readonly classes: readonly string[];
  readonly refuses: boolean;
  readonly ceiling: { readonly amountMinor: number; readonly currency: string } | null;
  readonly expiresAt: Date;
  readonly label: string;
  readonly graduationClass: string | null;
  readonly actorId: string;
}

/**
 * Files a mandate, or answers null when its expiry is not at least a minute
 * past the database's clock at the insert, so the caller refuses it by name
 * rather than the row's own check refusing it as an error.
 */
export async function insertMandate(
  tx: TenantQuery,
  filing: MandateFiling,
): Promise<MandateRow | null> {
  const rows = await tx.query<MandateDbRow>(
    `insert into public.standing_mandates as m
       (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at, label,
        graduation_class, authored_by_actor_id)
     select (select public.app_business_id()), $1::uuid, $2::uuid, $3::text[], $4::boolean,
            $5::bigint, $6::text, $7::timestamptz, $8::text, $9::text, $10::uuid
      where $7::timestamptz > clock_timestamp() + interval '1 minute'
     returning ${MANDATE_COLUMNS}`,
    [
      randomUUID(),
      filing.clientId,
      filing.classes,
      filing.refuses,
      filing.ceiling?.amountMinor ?? null,
      filing.ceiling?.currency ?? null,
      filing.expiresAt,
      filing.label,
      filing.graduationClass,
      filing.actorId,
    ],
  );
  return rows[0] === undefined ? null : mandateOf(rows[0]);
}

/** The mandate, locked for its revocation; null when it is not this business's. */
export async function lockMandate(
  tx: TenantQuery,
  mandateId: string,
): Promise<(MandateRow & { readonly revoked: boolean }) | null> {
  const rows = await tx.query<MandateDbRow & { readonly revoked: boolean }>(
    `select ${MANDATE_COLUMNS}, m.revoked_at is not null as revoked
       from public.standing_mandates m
      where m.business_id = (select public.app_business_id()) and m.id = $1
      for no key update`,
    [mandateId],
  );
  const row = rows[0];
  return row === undefined ? null : { ...mandateOf(row), revoked: row.revoked };
}

/** The graduation row a promote filed this mandate for, if one did. */
export async function graduationRowOf(tx: TenantQuery, mandateId: string): Promise<string | null> {
  const rows = await tx.query<{ readonly id: string }>(
    `select g.id from public.standing_mandates m
       join public.graduation_classes g
         on g.business_id = m.business_id and g.client_id = m.client_id
        and g.action_class = m.graduation_class
      where m.business_id = (select public.app_business_id()) and m.id = $1`,
    [mandateId],
  );
  return rows[0]?.id ?? null;
}

/** Revokes a live mandate as `actorId`, on the database's clock; its new revision. */
export async function revokeMandate(
  tx: TenantQuery,
  mandateId: string,
  actorId: string,
): Promise<number> {
  const rows = await tx.query<{ readonly revision: string }>(
    `update public.standing_mandates
        set revoked_at = clock_timestamp(), revoked_by_actor_id = $2, revision = revision + 1
      where business_id = (select public.app_business_id()) and id = $1 and revoked_at is null
      returning revision`,
    [mandateId, actorId],
  );
  return Number(rows[0]?.revision);
}
