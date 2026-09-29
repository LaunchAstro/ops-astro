// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view (C55), as the holder of `operations:read` is shown it.
// It places other parts' reads rather than keeping lists of its own; the
// privacy incidents are the part that is this view's own record, and each
// links the breach runbook published most recently (C81).
//
// Beside it, the breach drill's notices (C81): drafted from that runbook for
// the recipients the caller names, answered and never sent.

import {
  draftBreachNotices,
  isUuid,
  readPrivacyIncident,
  readPrivacyIncidents,
  readPublishedLegal,
} from '../../../core-records/src/index.ts';
import type { NoticeRecipient, TenantQuery } from '../../../core-records/src/index.ts';
import type { BreachNoticesResult, OperationsReadResult } from '../../../core-wire/src/index.ts';
import { invalid } from '../commands/operands.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';

export async function readOperations(tx: TenantQuery): Promise<Omit<OperationsReadResult, 'ok'>> {
  const incidents = await readPrivacyIncidents(tx);
  const runbook = await readPublishedLegal(tx, 'breach-runbook');
  return {
    privacyIncidents: incidents.map((incident) => ({
      id: incident.id,
      whatHappened: incident.whatHappened,
      foundAt: incident.foundAt.toISOString(),
      foundBy: incident.foundBy,
      affected: incident.affected,
      informationKinds: incident.informationKinds,
      assessBy: incident.assessBy.toISOString(),
      overdue: incident.overdue,
      status: incident.status,
      recordedAt: incident.recordedAt.toISOString(),
      recordedByActorId: incident.recordedByActorId,
    })),
    breachRunbook:
      runbook === undefined
        ? null
        : {
            version: runbook.version,
            digest: runbook.digest,
            publishedAt: runbook.publishedAt.toISOString(),
            body: runbook.body,
          },
  };
}

/** `privacy.draft_breach_notices`' operands, checked. */
export interface BreachNoticeOperands {
  readonly incidentId: string;
  readonly oaic: NoticeRecipient;
  readonly people: readonly NoticeRecipient[];
  readonly containment: string;
  readonly steps: string;
}

const RECIPIENT_FIX = 'Send each recipient as { name, address }, both non-empty text.';
const PEOPLE_FIX = `Send people as a list of one or more recipients, at most 500. ${RECIPIENT_FIX}`;

/** Text of 1 to `max` characters that is not blank. */
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;

function recipientOf(value: unknown): NoticeRecipient | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { name, address } = value as Readonly<Record<string, unknown>>;
  return isText(name, 200) && isText(address, 500) ? { name, address } : undefined;
}

function peopleOf(value: unknown): readonly NoticeRecipient[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return undefined;
  const people = value.map(recipientOf);
  return people.every((person) => person !== undefined)
    ? (people as readonly NoticeRecipient[])
    : undefined;
}

/**
 * The notices' operands, or the refusal naming the first one wrong. A missing
 * recipient or address is refused by name, so a drill never drafts a notice
 * addressed to nobody.
 */
export function parseBreachNotices(
  body: Readonly<Record<string, unknown>>,
): BreachNoticeOperands | CommandRefusal {
  const { incidentId, containment, steps } = body;
  if (typeof incidentId !== 'string' || !isUuid(incidentId)) {
    return invalid('incidentId', 'Send incidentId as the id of a privacy incident.');
  }
  const oaic = recipientOf(body['oaic']);
  if (oaic === undefined) return invalid('oaic', RECIPIENT_FIX);
  const people = peopleOf(body['people']);
  if (people === undefined) return invalid('people', PEOPLE_FIX);
  if (!isText(containment, 4000)) {
    return invalid('containment', 'Send containment as 1 to 4000 characters of text.');
  }
  if (!isText(steps, 4000)) return invalid('steps', 'Send steps as 1 to 4000 characters of text.');
  return { incidentId, oaic, people, containment, steps };
}

/** The notices drafted for this business's incident; nothing is written or sent. */
export async function readBreachNotices(
  tx: TenantQuery,
  operands: BreachNoticeOperands,
): Promise<BreachNoticesResult | CommandRefusal> {
  const incident = await readPrivacyIncident(tx, operands.incidentId);
  if (incident === undefined) return refuseNotFound();
  const runbook = await readPublishedLegal(tx, 'breach-runbook');
  if (runbook === undefined) {
    return refuseCommand(
      'BREACH_RUNBOOK_UNPUBLISHED',
      [],
      ['Publish a breach runbook, then draft the notices from it.'],
    );
  }
  const notices = draftBreachNotices(runbook.body, { ...operands, incident });
  if (notices === undefined) {
    return refuseCommand(
      'BREACH_TEMPLATE_UNFILLED',
      [],
      ['Publish a runbook version whose notice template the drill can fill.'],
    );
  }
  return { ok: true, runbook: { version: runbook.version, digest: runbook.digest }, notices };
}
