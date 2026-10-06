// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing mandates and graduation (MP-14-10a; owner answer 13).
//
// A mandate is structured: action classes and one client picked from lists, a
// value ceiling, an expiry, and a sentence that is its label only. What a row
// on the graduation list shows is derived here from the class's earned record
// and the live mandates for its client (`deriveGraduation`):
//
// - a class whose record is `never` shows `never`, whatever is filed;
// - a live refusal matching the class holds it, if it is ready or promoted;
// - a live mandate filed by promoting that class makes it run unattended;
// - otherwise the class shows what its record earned.
//
// Core's effect check (`standingMandateVerdict`) reads the same words
// (`classMatches`) and the same liveness, and covers only a class on its
// client's own list whose record is not `never`: a direct approval may cover
// any other class on the list (`ready`, `short`, `mixed` or `none`; a person
// filed it), never one a rule stopped and never one the client does not have.
//
// "Live" is not revoked and not past its expiry, judged on the database's
// clock (`clock_timestamp()`), never a time handed in. Every list here is
// filtered by the caller's scopes inside its statement, and every join is on
// the business as well as the id, beside the tenancy policy. A client's label
// is its name in `clients`.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Scope } from '../authority/grants.ts';

export type Earned = 'ready' | 'short' | 'mixed' | 'never' | 'none';
export type GraduationState = Earned | 'promoted' | 'held';

/** The whole-account word, a family (`social.*`) or one class (`social.post`). */
export const ALL_CLASSES = '*';

const WORD_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_';

/** One part of an action class: a small letter, then up to 31 small letters, digits or `_`. */
const isClassPart = (part: string): boolean =>
  part.length > 0 &&
  part.length <= 32 &&
  part[0] !== undefined &&
  part[0] >= 'a' &&
  part[0] <= 'z' &&
  [...part].every((one) => WORD_CHARS.includes(one));

/**
 * Whether text is an action class: two to four parts joined by `.`, each
 * `isClassPart` (the same form as `graduation_classes_class_shape`). Read part
 * by part against the allowed characters; anything else is not a class.
 */
export function isActionClass(text: string): boolean {
  const parts = text.split('.');
  return parts.length >= 2 && parts.length <= 4 && parts.every((part) => isClassPart(part));
}

/** A class's family word: `social.*` for `social.post`. */
const familyOf = (actionClass: string): string => `${actionClass.split('.')[0]}.*`;

/**
 * Whether a mandate's scope word covers an action class. The words are the
 * three `scopeChoices` offers, compared whole: the whole-account word, the
 * class's own family word, or the class itself. Any other word covers
 * nothing; nothing is evaluated as a pattern or a prefix.
 */
export function classMatches(scope: string, actionClass: string): boolean {
  return scope === ALL_CLASSES || scope === familyOf(actionClass) || scope === actionClass;
}

export interface MandateRow {
  readonly id: string;
  readonly clientId: string;
  readonly classes: readonly string[];
  readonly refuses: boolean;
  readonly ceilingMinor: number | null;
  readonly currency: string | null;
  readonly expiresAt: Date;
  /** Not past its expiry on the database's clock when it was read. */
  readonly live: boolean;
  readonly label: string;
  readonly graduationClass: string | null;
  readonly authoredBy: string;
  readonly createdAt: Date;
  readonly revision: number;
}

export interface GraduationClassRow {
  readonly id: string;
  readonly clientId: string;
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

/**
 * One class's state for its client, from the not-revoked mandates of that
 * client. A refusal holds a class that is ready or promoted; a class that
 * never earned the bar has nothing for a refusal to hold.
 */
export function deriveGraduation(
  row: GraduationClassRow,
  mandates: readonly MandateRow[],
): Derived {
  if (row.earned === 'never') return { state: 'never', heldBy: null, promotedBy: null };
  const live = mandates.filter((one) => one.clientId === row.clientId && one.live);
  const promotedBy = promotingMandate(row, mandates);
  const veto = live.find(
    (one) => one.refuses && one.classes.some((scope) => classMatches(scope, row.actionClass)),
  );
  if (veto !== undefined && (promotedBy !== null || row.earned === 'ready')) {
    return { state: 'held', heldBy: veto.id, promotedBy };
  }
  if (promotedBy !== null) return { state: 'promoted', heldBy: null, promotedBy };
  return { state: row.earned, heldBy: null, promotedBy: null };
}

/**
 * The live mandate that promoted this class, whatever its record shows now: a
 * class whose record turned `never` shows `never`, and still has a promotion
 * to end.
 */
export function promotingMandate(
  row: GraduationClassRow,
  mandates: readonly MandateRow[],
): MandateRow | null {
  return (
    mandates.find(
      (one) =>
        one.clientId === row.clientId &&
        one.live &&
        !one.refuses &&
        one.graduationClass === row.actionClass,
    ) ?? null
  );
}

/** The scope list a mandate for this client may pick from. */
export function scopeChoices(own: readonly string[]): readonly string[] {
  const classes = [...new Set(own)].toSorted();
  const families = [...new Set(classes.map((one) => familyOf(one)))].toSorted();
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
  readonly live: boolean;
  readonly label: string;
  readonly graduation_class: string | null;
  readonly authored_by_actor_id: string;
  readonly created_at: Date;
  readonly revision: string;
}

export const MANDATE_COLUMNS = `m.id, m.client_id, m.classes, m.refuses, m.ceiling_minor, m.currency,
  m.expires_at, m.expires_at > clock_timestamp() as live, m.label, m.graduation_class,
  m.authored_by_actor_id, m.created_at, m.revision`;

export const mandateOf = (row: MandateDbRow): MandateRow => ({
  id: row.id,
  clientId: row.client_id,
  classes: row.classes,
  refuses: row.refuses,
  ceilingMinor: row.ceiling_minor === null ? null : Number(row.ceiling_minor),
  currency: row.currency,
  expiresAt: row.expires_at,
  live: row.live,
  label: row.label,
  graduationClass: row.graduation_class,
  authoredBy: row.authored_by_actor_id,
  createdAt: row.created_at,
  revision: Number(row.revision),
});

export interface ClassDbRow {
  readonly id: string;
  readonly client_id: string;
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

export const classOf = (row: ClassDbRow): GraduationClassRow => ({
  id: row.id,
  clientId: row.client_id,
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

/** `$1` business-wide, `$2` the clients a party scope names. */
const reachOf = (scopes: readonly Scope[]): [boolean, readonly (string | null)[]] => [
  scopes.some((scope) => scope.kind === 'business'),
  scopes.filter((scope) => scope.kind === 'party').map((scope) => scope.id),
];

// One statement, so the client list, the graduation rows and the mandates
// come from one snapshot: a client committed mid-read is in all three or in
// none. Each list is a JSON array in the statement's order.
const GRADUATION_SQL = `select
  (select coalesce(json_agg(c order by c.label, c.id), '[]'::json)
     from (select k.id, k.name as label from public.clients k
            where k.business_id = (select public.app_business_id())
              and ($1::boolean or k.id = any($2::uuid[]))) c) as clients,
  (select coalesce(json_agg(g order by g.client_name, g.client_id, g.action_class), '[]'::json)
     from (select g.id, g.client_id, g.action_class, g.class_label,
                  g.clearance, g.earned, g.never_why, g.approved, g.edited, g.rejected,
                  g.since::text as since, g.note, g.revision::text as revision,
                  k.name as client_name
             from public.graduation_classes g
             join public.clients k on k.business_id = g.business_id and k.id = g.client_id
            where g.business_id = (select public.app_business_id())
              and ($1::boolean or g.client_id = any($2::uuid[]))) g) as classes,
  (select coalesce(json_agg(m order by m.created_at, m.id), '[]'::json)
     from (select ${MANDATE_COLUMNS}
             from public.standing_mandates m
            where m.business_id = (select public.app_business_id()) and m.revoked_at is null
              and ($1::boolean or m.client_id = any($2::uuid[]))) m) as mandates`;

/** A mandate row as JSON carries it: times as text, bigints as numbers. */
type MandateJsonRow = Omit<
  MandateDbRow,
  'ceiling_minor' | 'expires_at' | 'created_at' | 'revision'
> & {
  readonly ceiling_minor: number | null;
  readonly expires_at: string;
  readonly created_at: string;
  readonly revision: number;
};

const mandateOfJson = (row: MandateJsonRow): MandateRow =>
  mandateOf({
    ...row,
    ceiling_minor: row.ceiling_minor === null ? null : String(row.ceiling_minor),
    expires_at: new Date(row.expires_at),
    created_at: new Date(row.created_at),
    revision: String(row.revision),
  });

/**
 * The clients the scopes reach (each, whether or not it has a graduation
 * row), and their graduation rows and not-revoked mandates.
 */
export async function listGraduation(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<{
  readonly clients: readonly { readonly id: string; readonly label: string }[];
  readonly classes: readonly GraduationClassRow[];
  readonly mandates: readonly MandateRow[];
}> {
  const [read] = await tx.query<{
    readonly clients: readonly { readonly id: string; readonly label: string }[];
    readonly classes: readonly ClassDbRow[];
    readonly mandates: readonly MandateJsonRow[];
  }>(GRADUATION_SQL, reachOf(scopes));
  if (read === undefined) throw new Error('listGraduation: the statement returned no row');
  return {
    clients: read.clients.map((client) => ({ id: client.id, label: client.label })),
    classes: read.classes.map((row) => classOf(row)),
    mandates: read.mandates.map((row) => mandateOfJson(row)),
  };
}
