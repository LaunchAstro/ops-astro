// SPDX-License-Identifier: AGPL-3.0-only
//
// `privacy.record_incident` (C55): the tracked action `privacy incident
// recorded`, the breach runbook's day-0 step, under `privacy:manage`.
//
// Every field is checked here and refused `FIELD_VALUE_INVALID` naming the
// field alone: a refusal never repeats what was sent, because what was sent
// describes people. The applied detail carries the record's id and its
// assessment date and nothing else, since the operation register keeps the
// result beside the payload's digest.
//
// `foundAt` is judged against the database's clock, the one the table's own
// check reads, so a value this handler accepts is never refused by the
// constraint instead. A constraint refusal would be thrown as a driver error,
// and that error carries the statement's parameters: the incident's words.

import { INFORMATION_KINDS, recordPrivacyIncident } from '../../../core-records/src/index.ts';
import type { InformationKind, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Request = CommandRequest & { readonly command: 'privacy.record_incident' };

/** How far ahead of the server's clock day 0 may be, for a caller's clock drift. */
const FOUND_AT_SKEW_MS = 5 * 60 * 1000;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  whatHappened: ['Describe what happened in 1 to 4000 characters.'],
  foundAt: ['Send when it was found as an ISO 8601 time, not in the future.'],
  foundBy: ['Name who found it in 1 to 200 characters.'],
  affected: ['Say which clients and people in 1 to 2000 characters.'],
  informationKinds: [`Send one or more of: ${INFORMATION_KINDS.join(', ')}, each once.`],
};

const KINDS: ReadonlySet<string> = new Set(INFORMATION_KINDS);

function text(value: unknown, most: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= most ? trimmed : undefined;
}

/** Postgres raises 23514 on a failed check constraint. */
function isCheckViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === '23514'
  );
}

function foundAtOf(value: unknown, now: number): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now + FOUND_AT_SKEW_MS ? new Date(at) : undefined;
}

function kindsOf(value: unknown): readonly InformationKind[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > KINDS.size) return undefined;
  if (!value.every((kind) => typeof kind === 'string' && KINDS.has(kind))) return undefined;
  return new Set(value).size === value.length ? (value as InformationKind[]) : undefined;
}

export async function recordIncident(
  tx: TenantQuery,
  context: CommandContext,
  request: Request,
): Promise<HandlerOutcome> {
  const invalid = (field: string) =>
    refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

  const whatHappened = text(request.whatHappened, 4000);
  if (whatHappened === undefined) return invalid('whatHappened');
  const clock = await tx.query<{ readonly now: Date }>('select now() as now');
  const foundAt = foundAtOf(request.foundAt, (clock[0]?.now ?? new Date(0)).getTime());
  if (foundAt === undefined) return invalid('foundAt');
  const foundBy = text(request.foundBy, 200);
  if (foundBy === undefined) return invalid('foundBy');
  const affected = text(request.affected, 2000);
  if (affected === undefined) return invalid('affected');
  const informationKinds = kindsOf(request.informationKinds);
  if (informationKinds === undefined) return invalid('informationKinds');

  let incident;
  try {
    incident = await recordPrivacyIncident(
      tx,
      { whatHappened, foundAt, foundBy, affected, informationKinds },
      context.session.actorId,
    );
  } catch (cause) {
    // Refused in the handler's words, with nothing of the driver's error.
    if (isCheckViolation(cause)) return invalid('incident');
    throw cause;
  }
  return applied(incident.id, null, {
    incidentId: incident.id,
    assessBy: incident.assessBy.toISOString(),
  });
}
