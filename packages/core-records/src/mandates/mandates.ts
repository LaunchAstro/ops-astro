// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing mandates and graduation (MP-14-10a; owner answer 13).
//
// A mandate is structured: action classes and one client picked from lists, a
// value ceiling, an expiry, and a sentence that is its label only. What a row
// on the graduation list shows is derived here from the class's earned record
// and the live mandates for its client, in one place, so the read, the promote
// check and core's effect check cannot disagree about what holds a class:
//
// - a live refusal matching the class holds it, whatever it earned;
// - a live mandate filed by promoting that class makes it run unattended;
// - otherwise the class shows what its record earned.
//
// "Live" is not revoked and not past its expiry. Every list here is filtered
// by the caller's scopes inside its statement.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Scope } from '../authority/grants.ts';

export type Earned = 'ready' | 'short' | 'mixed' | 'never' | 'none';
export type GraduationState = Earned | 'promoted' | 'held';

/** The whole-account word, a family (`social.*`) or one class (`social.post`). */
export const ALL_CLASSES = '*';

export function classMatches(scope: string, actionClass: string): boolean {
  if (scope === ALL_CLASSES || scope === actionClass) return true;
  return scope.endsWith('.*') && actionClass.startsWith(scope.slice(0, -1));
}

export interface MandateRow {
  readonly id: string;
  readonly clientId: string;
  readonly classes: readonly string[];
  readonly refuses: boolean;
  readonly ceilingMinor: number | null;
  readonly currency: string | null;
  readonly expiresAt: Date;
  readonly label: string;
  readonly graduationClass: string | null;
  readonly authoredBy: string;
  readonly createdAt: Date;
  readonly revision: number;
}

export interface GraduationClassRow {
  readonly id: string;
  readonly clientId: string;
  readonly clientLabel: string;
  readonly actionClass: string;
  readonly classLabel: string;
  readonly clearance: string;
  readonly earned: Earned;
  readonly neverWhy: 'ceiling' | 'audience' | null;
  readonly approved: number;
  readonly edited: number;
  readonly rejected: number;
  readonly since: string | null;
  readonly note: string;
  readonly revision: number;
}

export interface Derived {
  readonly state: GraduationState;
  readonly heldBy: string | null;
  readonly promotedBy: MandateRow | null;
}

export const mandateIsLive = (mandate: MandateRow, at: Date): boolean =>
  mandate.expiresAt.getTime() > at.getTime();

/**
 * One class's state for its client, from the not-revoked mandates of that
 * client. A refusal holds a class that is ready or promoted; a class that
 * never earned the bar has nothing for a refusal to hold.
 */
export function deriveGraduation(
  row: GraduationClassRow,
  mandates: readonly MandateRow[],
  at: Date,
): Derived {
  const live = mandates.filter((one) => one.clientId === row.clientId && mandateIsLive(one, at));
  const promotedBy =
    live.find((one) => !one.refuses && one.graduationClass === row.actionClass) ?? null;
  const veto = live.find(
    (one) => one.refuses && one.classes.some((scope) => classMatches(scope, row.actionClass)),
  );
  if (veto !== undefined && (promotedBy !== null || row.earned === 'ready')) {
    return { state: 'held', heldBy: veto.id, promotedBy };
  }
  if (promotedBy !== null) return { state: 'promoted', heldBy: null, promotedBy };
  return { state: row.earned, heldBy: null, promotedBy: null };
}

/** The scope list a mandate for this client may pick from. */
export function scopeChoices(own: readonly string[]): readonly string[] {
  const classes = [...new Set(own)].toSorted();
  const families = [...new Set(classes.map((one) => `${one.split('.')[0]}.*`))].toSorted();
  return [ALL_CLASSES, ...families, ...classes];
}

export interface MandateDbRow {
  readonly id: string;
  readonly client_id: string;
  readonly classes: readonly string[];
  readonly refuses: boolean;
  readonly ceiling_minor: string | null;
  readonly currency: string | null;
  readonly expires_at: Date;
  readonly label: string;
  readonly graduation_class: string | null;
  readonly authored_by_actor_id: string;
  readonly created_at: Date;
  readonly revision: string;
}

export const MANDATE_COLUMNS = `id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
  label, graduation_class, authored_by_actor_id, created_at, revision`;

export const mandateOf = (row: MandateDbRow): MandateRow => ({
  id: row.id,
  clientId: row.client_id,
  classes: row.classes,
  refuses: row.refuses,
  ceilingMinor: row.ceiling_minor === null ? null : Number(row.ceiling_minor),
  currency: row.currency,
  expiresAt: row.expires_at,
  label: row.label,
  graduationClass: row.graduation_class,
  authoredBy: row.authored_by_actor_id,
  createdAt: row.created_at,
  revision: Number(row.revision),
});

export interface ClassDbRow {
  readonly id: string;
  readonly client_id: string;
  readonly client_label: string;
  readonly action_class: string;
  readonly class_label: string;
  readonly clearance: string;
  readonly earned: Earned;
  readonly never_why: 'ceiling' | 'audience' | null;
  readonly approved: number;
  readonly edited: number;
  readonly rejected: number;
  readonly since: string | null;
  readonly note: string;
  readonly revision: string;
}

export const CLASS_COLUMNS = `id, client_id, client_label, action_class, class_label, clearance, earned,
  never_why, approved, edited, rejected, since::text as since, note, revision`;

export const classOf = (row: ClassDbRow): GraduationClassRow => ({
  id: row.id,
  clientId: row.client_id,
  clientLabel: row.client_label,
  actionClass: row.action_class,
  classLabel: row.class_label,
  clearance: row.clearance,
  earned: row.earned,
  neverWhy: row.never_why,
  approved: row.approved,
  edited: row.edited,
  rejected: row.rejected,
  since: row.since,
  note: row.note,
  revision: Number(row.revision),
});

const reachOf = (scopes: readonly Scope[]): [boolean, readonly (string | null)[]] => [
  scopes.some((scope) => scope.kind === 'business'),
  scopes.filter((scope) => scope.kind === 'party').map((scope) => scope.id),
];

/** The graduation rows and not-revoked mandates of the clients the scopes reach. */
export async function listGraduation(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<{
  readonly classes: readonly GraduationClassRow[];
  readonly mandates: readonly MandateRow[];
}> {
  const [whole, parties] = reachOf(scopes);
  const classes = await tx.query<ClassDbRow>(
    `select ${CLASS_COLUMNS} from public.graduation_classes
      where $1::boolean or client_id = any($2::uuid[])
      order by client_label, client_id, action_class`,
    [whole, parties],
  );
  const mandates = await tx.query<MandateDbRow>(
    `select ${MANDATE_COLUMNS} from public.standing_mandates
      where revoked_at is null and ($1::boolean or client_id = any($2::uuid[]))
      order by created_at, id`,
    [whole, parties],
  );
  return {
    classes: classes.map((row) => classOf(row)),
    mandates: mandates.map((row) => mandateOf(row)),
  };
}

/**
 * The not-revoked mandates of one client, share-locked: a revoke of any of
 * them waits for this transaction, and this read waits for a revoke already
 * under way. Core's effect check and the promote check both read through it.
 */
export async function lockClientMandates(
  tx: TenantQuery,
  clientId: string,
): Promise<readonly MandateRow[]> {
  const rows = await tx.query<MandateDbRow>(
    `select ${MANDATE_COLUMNS} from public.standing_mandates
      where client_id = $1 and revoked_at is null
      order by created_at, id
      for share`,
    [clientId],
  );
  return rows.map((row) => mandateOf(row));
}

/** The client's own classes, as the scope list is built from them. */
export async function clientClasses(tx: TenantQuery, clientId: string): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly action_class: string }>(
    `select action_class from public.graduation_classes where client_id = $1`,
    [clientId],
  );
  return rows.map((row) => row.action_class);
}
