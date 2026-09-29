// SPDX-License-Identifier: AGPL-3.0-only
//
// The writes behind graduation and standing mandates (MP-14-10a): each takes
// the row lock its command serialises on. A mandate is filed and revoked,
// never edited; a graduation row only has its revision bumped when a promote
// or demote moves the class it describes.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  CLASS_COLUMNS,
  MANDATE_COLUMNS,
  classOf,
  mandateOf,
  type ClassDbRow,
  type GraduationClassRow,
  type MandateDbRow,
  type MandateRow,
} from './mandates.ts';

/** One graduation row, locked for the promote or demote that moves it. */
export async function lockGraduationClass(
  tx: TenantQuery,
  classId: string,
): Promise<GraduationClassRow | null> {
  const rows = await tx.query<ClassDbRow>(
    `select ${CLASS_COLUMNS} from public.graduation_classes where id = $1 for update`,
    [classId],
  );
  return rows[0] === undefined ? null : classOf(rows[0]);
}

export async function bumpGraduationClass(tx: TenantQuery, classId: string): Promise<number> {
  const rows = await tx.query<{ readonly revision: string }>(
    `update public.graduation_classes set revision = revision + 1 where id = $1
     returning revision`,
    [classId],
  );
  return Number(rows[0]?.revision);
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

export async function insertMandate(tx: TenantQuery, filing: MandateFiling): Promise<MandateRow> {
  const rows = await tx.query<MandateDbRow>(
    `insert into public.standing_mandates
       (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at, label,
        graduation_class, authored_by_actor_id)
     values ((select public.app_business_id()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
  const row = rows[0];
  if (row === undefined) throw new Error('insertMandate: no row returned');
  return mandateOf(row);
}

/** The mandate, locked for its revocation; null when it is not this business's. */
export async function lockMandate(
  tx: TenantQuery,
  mandateId: string,
): Promise<(MandateRow & { readonly revoked: boolean }) | null> {
  const rows = await tx.query<MandateDbRow & { readonly revoked: boolean }>(
    `select ${MANDATE_COLUMNS}, revoked_at is not null as revoked
       from public.standing_mandates where id = $1 for update`,
    [mandateId],
  );
  const row = rows[0];
  return row === undefined ? null : { ...mandateOf(row), revoked: row.revoked };
}

export async function revokeMandate(
  tx: TenantQuery,
  mandateId: string,
  actorId: string,
): Promise<number> {
  const rows = await tx.query<{ readonly revision: string }>(
    `update public.standing_mandates
        set revoked_at = now(), revoked_by_actor_id = $2, revision = revision + 1
      where id = $1 and revoked_at is null
      returning revision`,
    [mandateId, actorId],
  );
  return Number(rows[0]?.revision);
}
