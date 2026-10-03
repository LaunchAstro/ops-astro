// SPDX-License-Identifier: AGPL-3.0-only
//
// `client.set_privacy` (C60, CS-7.40): the tracked action `client privacy
// setting changed (model egress, providers, health, no agent edits)`, under
// `privacy:manage` on the named client (party scope, `prepare.ts`), never an
// agent's. Every setting is sent each time, so a change is the whole row.
//
// Switching model egress on (off to on, or to other providers) takes the
// client's written request in the same command, and refuses without one
// (owner line 51). A request is kept with what came of it, in the same
// transaction as the change, and kept when the switch is refused: a cloud
// provider while no local-model path exists (owner line 72), a client that
// handles health information, or a provider with no assessed row on the
// overseas-services register (APP 8.1).
//
// A refusal names fields and never repeats what was sent; the applied detail
// carries the client's id alone.

import { LOCAL_MODEL_REQUIRED_WORDS } from '../../../core-connectors/src/index.ts';
import {
  isUuid,
  judgeModelRequest,
  MODEL_PROVIDERS,
  readClientPrivacy,
  recordModelRequest,
  writeClientPrivacy,
} from '../../../core-records/src/index.ts';
import type { ClientPrivacy, ModelRequest, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, refusedRetaining, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Request = CommandRequest & { readonly command: 'client.set_privacy' };

const REQUEST_FIELDS = ['requestedBy', 'requestedOn', 'requestLink'] as const;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  clientId: ['Name one client of this business by its identifier.'],
  modelEgress: ['Send true for model use on, or false.'],
  providers: [
    `Name each provider once, from: ${MODEL_PROVIDERS.join(', ')}; none while model use is off.`,
  ],
  handlesHealth: ['Send true if the client handles health information, or false.'],
  noAgentEdits: ['Send true to keep agent edits off this client, or false.'],
  requestedBy: ['Send a written request only when switching model use on.'],
};

const REFUSALS = {
  CLIENT_REQUEST_REQUIRED: [
    "Model use goes on only at the client's written request, sent in the same command.",
    'Send requestedBy (1 to 200 characters), requestedOn (YYYY-MM-DD) and requestLink (1 to 2000).',
  ],
  LOCAL_MODEL_REQUIRED: [
    LOCAL_MODEL_REQUIRED_WORDS,
    "The client's request is recorded; model use stays off.",
  ],
  CLIENT_HANDLES_HEALTH: [
    'A client that handles health information keeps model use off.',
    'Any request sent is recorded; model use stays off.',
  ],
  PROVIDER_NOT_ASSESSED: [
    'Record an assessed row in use for each provider on the overseas-services register first.',
    "The client's request is recorded; model use stays off.",
  ],
} as const;

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

function text(value: unknown, most: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= most ? trimmed : undefined;
}

/** A calendar date as YYYY-MM-DD that exists. */
function dateOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().startsWith(value) ? value : undefined;
}

function providersOf(value: unknown, on: boolean): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MODEL_PROVIDERS.length) return undefined;
  const known: readonly unknown[] = MODEL_PROVIDERS;
  if (!value.every((each) => known.includes(each))) return undefined;
  if (new Set(value).size !== value.length || value.length > 0 !== on) return undefined;
  return value as string[];
}

/** The settings sent, or the first field that does not hold. */
function settingsOf(request: Request): ClientPrivacy | string {
  const { modelEgress, handlesHealth, noAgentEdits } = request;
  if (typeof modelEgress !== 'boolean') return 'modelEgress';
  const providers = providersOf(request.providers, modelEgress);
  if (providers === undefined) return 'providers';
  if (typeof handlesHealth !== 'boolean') return 'handlesHealth';
  if (typeof noAgentEdits !== 'boolean') return 'noAgentEdits';
  return { modelEgress, providers, handlesHealth, noAgentEdits };
}

/** The written request, whole, or null when any part is missing or malformed. */
function requestOf(
  request: Request,
  clientId: string,
  providers: readonly string[],
): ModelRequest | null {
  const requestedBy = text(request.requestedBy, 200);
  const requestedOn = dateOf(request.requestedOn);
  const requestLink = text(request.requestLink, 2000);
  if (requestedBy === undefined || requestedOn === undefined || requestLink === undefined) {
    return null;
  }
  return { clientId, requestedBy, requestedOn, requestLink, providers };
}

const switchesOn = (now: ClientPrivacy, next: ClientPrivacy): boolean =>
  next.modelEgress && (!now.modelEgress || now.providers.join() !== next.providers.join());

/** A change that leaves model use as it is, or off: no request goes with it. */
function refuseOtherChange(request: Request, next: ClientPrivacy): HandlerOutcome | undefined {
  if (REQUEST_FIELDS.some((field) => request[field] !== undefined)) return invalid('requestedBy');
  if (!next.modelEgress || !next.handlesHealth) return undefined;
  return refused(
    refuseCommand('CLIENT_HANDLES_HEALTH', ['handlesHealth'], REFUSALS.CLIENT_HANDLES_HEALTH),
  );
}

/** Switching model use on: the request, kept with what came of it, then the refusal or nothing. */
async function refuseSwitchOn(
  tx: TenantQuery,
  context: CommandContext,
  request: Request,
  next: ClientPrivacy,
): Promise<HandlerOutcome | undefined> {
  const written = requestOf(request, request.clientId.toLowerCase(), next.providers);
  if (written === null) {
    const { CLIENT_REQUEST_REQUIRED: fixes } = REFUSALS;
    return refused(refuseCommand('CLIENT_REQUEST_REQUIRED', [...REQUEST_FIELDS], fixes));
  }
  const outcome = await judgeModelRequest(tx, next.providers, next.handlesHealth);
  await recordModelRequest(tx, written, outcome, context.session.actorId);
  if (outcome === 'applied') return undefined;
  return refusedRetaining(refuseCommand(outcome, ['providers'], REFUSALS[outcome]));
}

export async function setClientPrivacy(
  tx: TenantQuery,
  context: CommandContext,
  request: Request,
): Promise<HandlerOutcome> {
  if (!isUuid(request.clientId)) return invalid('clientId');
  const clientId = request.clientId.toLowerCase();
  const next = settingsOf(request);
  if (typeof next === 'string') return invalid(next);
  const now = await readClientPrivacy(tx, clientId, true);
  if (now === undefined) return refused(refuseNotFound());
  const refusal = switchesOn(now, next)
    ? await refuseSwitchOn(tx, context, request, next)
    : refuseOtherChange(request, next);
  if (refusal !== undefined) return refusal;
  await writeClientPrivacy(tx, clientId, next);
  return applied(clientId, null, { clientId });
}
