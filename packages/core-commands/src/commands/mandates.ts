// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing mandates and graduation (MP-14-10a, CS-14.17 to CS-14.19; owner
// answer 13).
//
// The envelope has already checked `mandate:manage` business-wide, refused
// every agent (all four rows are `agent: never`) and, because the key is in
// the money set, asked for a sign-in in the last sixty minutes (C59). That
// grant check is not held to the write, so each command asks it again with
// the caller's `mandate` grants held for share, after its own row lock and
// before it answers anything about the row: a revocation that committed first
// refuses the command, and one that comes second waits for it to commit.
//
// What is left is the value: classes picked from the client's own scope list,
// a ceiling in whole minor units of one currency, an expiry at least a minute
// past the database's clock, and a sentence that is a label and nothing more.
// Nothing files until each is set, and each refusal names the field it refuses
// without echoing what was sent.
//
// Every command locks in core's order: the client's row, then the graduation
// row, then the mandate. Filing a refusal therefore waits for any effect whose
// core check holds the client's row in share (`standingMandateVerdict`), and
// the next check sees it. Promoting and demoting lock the graduation row, so
// two switches on one class serialise and the second sees the first's
// mandate. Revoking locks the mandate too, so it waits for an effect whose
// check holds it, and an effect already past that check stands.

import {
  bumpGraduationClass,
  clientClasses,
  clientOfClass,
  clientOfMandate,
  deriveGraduation,
  graduationRowOf,
  insertMandate,
  isUuid,
  lockClientMandates,
  lockClientForWrite,
  lockGraduationClass,
  lockMandate,
  revokeMandate,
  scopeChoices,
  subjectsOf,
  type MandateFiling,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { storableText } from './values.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

type Ceiling = NonNullable<MandateFiling['ceiling']>;

const FIXES: Readonly<Record<string, string>> = {
  classes: 'Send classes as a list of distinct entries from the client scope list.',
  refuses: 'Send refuses as true for a refusal, or leave it out.',
  ceiling:
    'Send ceiling as { amountMinor, currency }: whole minor units of a three-letter currency; a refusal sends none.',
  expiresAt: 'Send expiresAt as an ISO 8601 UTC time with milliseconds, at least a minute ahead.',
  label: 'Send label as the sentence, 1 to 500 characters.',
  expectedRevision: 'Send expectedRevision as the whole number the region showed, or leave it out.',
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [FIXES[field] ?? '']));

const notGranted = (): HandlerOutcome =>
  refused(
    refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['no live grant covers it', 'ask a holder who may delegate'],
    ),
  );

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

/** `mandate:manage` business-wide, judged at the instant the grants are held. */
async function stillManagesMandates(tx: TenantQuery, context: CommandContext): Promise<boolean> {
  const subjects = subjectsOf(context.session);
  await holdCoveringGrants(tx, subjects, 'mandate');
  const at = await lockedInstant(tx);
  const decision = await checkAuthorityAt(
    tx,
    subjects,
    { collection: 'mandate', action: 'manage', scope: { kind: 'business', id: null } },
    at,
  );
  return decision.ok;
}

/** The class's client's row, then the class's row, both locked; null when not this business's. */
async function lockClassInOrder(tx: TenantQuery, classId: string) {
  const clientId = isUuid(classId) ? await clientOfClass(tx, classId) : null;
  if (clientId === null) return null;
  await lockClientForWrite(tx, clientId);
  return await lockGraduationClass(tx, classId);
}

/** Exactly `{ amountMinor, currency }`: a safe whole number and three capital letters. */
function ceilingOf(value: unknown): Ceiling | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).toSorted();
  if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currency') return null;
  const { amountMinor, currency } = value as Record<string, unknown>;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return null;
  }
  const upper = typeof currency === 'string' && currency.length === 3;
  if (!upper || [...currency].some((one) => one < 'A' || one > 'Z')) return null;
  return { amountMinor, currency };
}

/**
 * One form only, the one `Date.prototype.toISOString` writes: a time that does
 * not read back as itself is refused, so no locale or partial date is guessed.
 * Whether it is far enough ahead is the insert's, on the database's clock.
 */
function expiryOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) || at.toISOString() !== value ? null : at;
}

function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  // Postgres text and jsonb (the audit row) refuse a NUL and a lone surrogate.
  if (label.length === 0 || label.length > 500 || !storableText(label)) return null;
  return label;
}

/** Distinct entries of the client's own scope list, compared whole. */
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
  // Another business's client is not in this transaction's rows, so it
  // answers exactly as a fabricated or malformed identifier does.
  const client = isUuid(request.clientId) && (await lockClientForWrite(tx, request.clientId));
  if (!(await stillManagesMandates(tx, context))) return notGranted();
  const own = client ? await clientClasses(tx, request.clientId) : [];
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
  const expiresAt = expiryOf(request.expiresAt);
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
  if (mandate === null) return invalid('expiresAt');
  return applied(mandate.id, mandate.revision, { mandateId: mandate.id, refuses });
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
  // The client's row, then the graduation row a promote filed this mandate
  // for (revoking it moves that class back to ready), then the mandate.
  const clientId = isUuid(request.mandateId) ? await clientOfMandate(tx, request.mandateId) : null;
  if (clientId !== null) await lockClientForWrite(tx, clientId);
  const classId = clientId === null ? null : await graduationRowOf(tx, request.mandateId);
  if (classId !== null) await lockGraduationClass(tx, classId);
  const mandate = clientId === null ? null : await lockMandate(tx, request.mandateId);
  if (!(await stillManagesMandates(tx, context))) return notGranted();
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
  const row = await lockClassInOrder(tx, request.classId);
  if (!(await stillManagesMandates(tx, context))) return notGranted();
  if (row === null) return refused(refuseNotFound());
  if (expectedRevision !== undefined && expectedRevision !== row.revision) {
    return stale(row.revision);
  }
  const { state } = deriveGraduation(row, await lockClientMandates(tx, row.clientId));
  if (state !== 'ready') {
    return notPermitted(state, 'Only a class that clears the bar, held by nothing, is promoted.');
  }
  const ceiling = ceilingOf(request.ceiling);
  if (ceiling === null) return invalid('ceiling');
  const expiresAt = expiryOf(request.expiresAt);
  if (expiresAt === null) return invalid('expiresAt');
  const mandate = await insertMandate(tx, {
    clientId: row.clientId,
    classes: [row.actionClass],
    refuses: false,
    ceiling,
    expiresAt,
    // Both labels are at most 200 characters (the migration's checks), so this fits the 500.
    label: `Run ${row.classLabel} unattended for ${row.clientLabel}`,
    graduationClass: row.actionClass,
    actorId: context.session.actorId,
  });
  if (mandate === null) return invalid('expiresAt');
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
  const row = await lockClassInOrder(tx, request.classId);
  if (!(await stillManagesMandates(tx, context))) return notGranted();
  if (row === null) return refused(refuseNotFound());
  if (expectedRevision !== undefined && expectedRevision !== row.revision) {
    return stale(row.revision);
  }
  const derived = deriveGraduation(row, await lockClientMandates(tx, row.clientId));
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
