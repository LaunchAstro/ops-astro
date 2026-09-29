// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing mandates and graduation (MP-14-10a, CS-14.17 to CS-14.19; owner
// answer 13).
//
// The envelope has already checked `mandate:manage` business-wide and refused
// every agent (all four rows are `agent: never`). What is left is the value:
// classes and client picked from the client's own lists, a ceiling in whole
// minor units of one currency, an expiry after now, and a sentence that is a
// label and nothing more. Nothing files until each is set, and each refusal
// names the field it refuses without echoing what was sent.
//
// Promoting and demoting lock the graduation row, so two switches on one
// class serialise and the second sees the first's mandate. Revoking locks the
// mandate, so it waits for any effect whose core check holds it in share
// (`standingMandateVerdict`), and an effect already past that check stands.

import {
  bumpGraduationClass,
  clientClasses,
  deriveGraduation,
  insertMandate,
  isUuid,
  lockClientMandates,
  lockGraduationClass,
  lockMandate,
  revokeMandate,
  scopeChoices,
  type MandateFiling,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

type Ceiling = NonNullable<MandateFiling['ceiling']>;

const FIXES: Readonly<Record<string, string>> = {
  classes: 'Send classes as a list of distinct entries from the client scope list.',
  refuses: 'Send refuses as true for a refusal, or leave it out.',
  ceiling:
    'Send ceiling as { amountMinor, currency }: whole minor units of a three-letter currency; a refusal sends none.',
  expiresAt: 'Send expiresAt as a date and time after now.',
  label: 'Send label as the sentence, 1 to 500 characters.',
  expectedRevision: 'Send expectedRevision as the whole number the region showed, or leave it out.',
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [FIXES[field] ?? '']));

const stale = (revision: number): HandlerOutcome =>
  refused(
    refuseCommand(
      'VERSION_STALE',
      [`revision=${revision}`],
      ['Read the region again and act on the revision it is at now.'],
    ),
  );

const notPermitted = (state: string, fix: string): HandlerOutcome =>
  refused(refuseCommand('TRANSITION_NOT_PERMITTED', [`state=${state}`], [fix]));

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

function ceilingOf(value: unknown): Ceiling | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).toSorted();
  if (keys.join(',') !== 'amountMinor,currency') return null;
  const { amountMinor, currency } = value as Record<string, unknown>;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return null;
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency)) return null;
  return { amountMinor, currency };
}

// A minute's margin: the row's own check compares the expiry with the
// database clock at insert, and a refusal must come from here, not from it.
const EXPIRY_MARGIN_MS = 60_000;

function expiryOf(value: unknown, now: number): Date | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) || at <= now + EXPIRY_MARGIN_MS ? null : new Date(at);
}

// jsonb and Postgres text refuse a NUL, and jsonb a lone surrogate; the label
// reaches both through the audit row.
const UNSTORABLE = /[\0\p{Surrogate}]/u;

function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label.length === 0 || label.length > 500 || UNSTORABLE.test(label)) return null;
  return label;
}

function classesOf(value: unknown, choices: readonly string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  if (!value.every((one): one is string => typeof one === 'string' && choices.includes(one))) {
    return null;
  }
  return new Set(value).size === value.length ? value : null;
}

export async function fileMandate(
  tx: TenantQuery,
  context: CommandContext,
  request: {
    readonly clientId: string;
    readonly classes?: unknown;
    readonly refuses?: unknown;
    readonly ceiling?: unknown;
    readonly expiresAt?: unknown;
    readonly label?: unknown;
  },
): Promise<HandlerOutcome> {
  // Another business's client has no classes in this transaction's rows (RLS),
  // so it answers exactly as a fabricated or malformed identifier does.
  if (!isUuid(request.clientId)) return refused(refuseNotFound());
  const own = await clientClasses(tx, request.clientId);
  if (own.length === 0) return refused(refuseNotFound());
  const classes = classesOf(request.classes, scopeChoices(own));
  if (classes === null) return invalid('classes');
  if (request.refuses !== undefined && typeof request.refuses !== 'boolean') {
    return invalid('refuses');
  }
  const refuses = request.refuses === true;
  const ceiling = refuses ? null : ceilingOf(request.ceiling);
  if (refuses ? request.ceiling !== undefined && request.ceiling !== null : ceiling === null) {
    return invalid('ceiling');
  }
  const expiresAt = expiryOf(request.expiresAt, Date.now());
  if (expiresAt === null) return invalid('expiresAt');
  const label = labelOf(request.label);
  if (label === null) return invalid('label');
  const mandate = await insertMandate(tx, {
    clientId: request.clientId,
    classes,
    refuses,
    ceiling,
    expiresAt,
    label,
    graduationClass: null,
    actorId: context.session.actorId,
  });
  return applied(mandate.id, mandate.revision, { mandateId: mandate.id, refuses });
}

/** The graduation row a promote filed this mandate for, if one did. */
async function graduationRowOf(tx: TenantQuery, mandateId: string): Promise<string | null> {
  const rows = await tx.query<{ readonly id: string }>(
    `select g.id from public.standing_mandates m
       join public.graduation_classes g
         on g.client_id = m.client_id and g.action_class = m.graduation_class
      where m.id = $1`,
    [mandateId],
  );
  return rows[0]?.id ?? null;
}

export async function revokeStandingMandate(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly mandateId: string; readonly expectedRevision?: unknown },
): Promise<HandlerOutcome> {
  const { expectedRevision } = request;
  if (expectedRevision !== undefined && !isRevision(expectedRevision)) {
    return invalid('expectedRevision');
  }
  if (!isUuid(request.mandateId)) return refused(refuseNotFound());
  // The lock order is the graduation row, then the mandate, as promote and
  // demote take them: a mandate a promote filed moves its class back to ready.
  const classId = await graduationRowOf(tx, request.mandateId);
  if (classId !== null) await lockGraduationClass(tx, classId);
  const mandate = await lockMandate(tx, request.mandateId);
  if (mandate === null) return refused(refuseNotFound());
  if (expectedRevision !== undefined && expectedRevision !== mandate.revision) {
    return stale(mandate.revision);
  }
  if (mandate.revoked) {
    return notPermitted('revoked', 'This mandate is already revoked; file a new one if needed.');
  }
  const revision = await revokeMandate(tx, mandate.id, context.session.actorId);
  if (classId !== null) await bumpGraduationClass(tx, classId);
  return applied(mandate.id, revision, { mandateId: mandate.id, state: 'revoked' });
}

export async function promoteClass(
  tx: TenantQuery,
  context: CommandContext,
  request: {
    readonly classId: string;
    readonly ceiling?: unknown;
    readonly expiresAt?: unknown;
    readonly expectedRevision?: unknown;
  },
): Promise<HandlerOutcome> {
  const { expectedRevision } = request;
  if (expectedRevision !== undefined && !isRevision(expectedRevision)) {
    return invalid('expectedRevision');
  }
  if (!isUuid(request.classId)) return refused(refuseNotFound());
  const row = await lockGraduationClass(tx, request.classId);
  if (row === null) return refused(refuseNotFound());
  if (expectedRevision !== undefined && expectedRevision !== row.revision) {
    return stale(row.revision);
  }
  const now = new Date();
  const { state } = deriveGraduation(row, await lockClientMandates(tx, row.clientId), now);
  if (state !== 'ready') {
    return notPermitted(state, 'Only a class that clears the bar, held by nothing, is promoted.');
  }
  const ceiling = ceilingOf(request.ceiling);
  if (ceiling === null) return invalid('ceiling');
  const expiresAt = expiryOf(request.expiresAt, now.getTime());
  if (expiresAt === null) return invalid('expiresAt');
  const mandate = await insertMandate(tx, {
    clientId: row.clientId,
    classes: [row.actionClass],
    refuses: false,
    ceiling,
    expiresAt,
    // Both labels are at most 200 characters (0035), so this fits the 500.
    label: `Run ${row.classLabel} unattended for ${row.clientLabel}`,
    graduationClass: row.actionClass,
    actorId: context.session.actorId,
  });
  const revision = await bumpGraduationClass(tx, row.id);
  return applied(row.id, revision, { classId: row.id, mandateId: mandate.id, state: 'promoted' });
}

export async function demoteClass(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly classId: string; readonly expectedRevision?: unknown },
): Promise<HandlerOutcome> {
  const { expectedRevision } = request;
  if (expectedRevision !== undefined && !isRevision(expectedRevision)) {
    return invalid('expectedRevision');
  }
  if (!isUuid(request.classId)) return refused(refuseNotFound());
  const row = await lockGraduationClass(tx, request.classId);
  if (row === null) return refused(refuseNotFound());
  if (expectedRevision !== undefined && expectedRevision !== row.revision) {
    return stale(row.revision);
  }
  const derived = deriveGraduation(row, await lockClientMandates(tx, row.clientId), new Date());
  if (derived.state !== 'promoted' || derived.promotedBy === null) {
    return notPermitted(derived.state, 'Only a class running unattended is demoted.');
  }
  await revokeMandate(tx, derived.promotedBy.id, context.session.actorId);
  const revision = await bumpGraduationClass(tx, row.id);
  return applied(row.id, revision, {
    classId: row.id,
    mandateId: derived.promotedBy.id,
    state: 'ready',
  });
}
