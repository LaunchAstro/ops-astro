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
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { ceilingOf, classesOf, expiryOf, isRevision, labelOf, shownAs } from './mandate-inputs.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

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
    // Each name is at most 200 characters (the migration's checks) and is shown
    // only when it is a label's text, so this fits the 500 and the label grammar.
    label: `Run ${shownAs(row.classLabel, row.actionClass)} unattended for ${shownAs(row.clientLabel, `client ${row.clientId}`)}`,
    graduationClass: row.actionClass,
    actorId: context.session.actorId,
  });
  if (mandate === null) return invalid('expiresAt');
  const revision = await bumpGraduationClass(tx, row.id);
  // The class is the handle the caller writes against; the audit names the mandate filed.
  return {
    ...applied(row.id, revision, { classId: row.id, mandateId: mandate.id, state: 'promoted' }),
    auditSubjectId: mandate.id,
  };
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
  const mandates = await lockClientMandates(tx, row.clientId);
  // A promoted class a refusal is holding is demoted too: otherwise its
  // promotion runs unattended again the moment the refusal ends.
  const { state, promotedBy } = deriveGraduation(row, mandates);
  if (promotedBy === null) {
    return notPermitted(state, 'Only a class promoted to run unattended is demoted.');
  }
  await revokeMandate(tx, promotedBy.id, context.session.actorId);
  const revision = await bumpGraduationClass(tx, row.id);
  const after = deriveGraduation(
    row,
    mandates.filter((one) => one.id !== promotedBy.id),
  );
  return {
    ...applied(row.id, revision, { classId: row.id, mandateId: promotedBy.id, state: after.state }),
    auditSubjectId: promotedBy.id,
  };
}
