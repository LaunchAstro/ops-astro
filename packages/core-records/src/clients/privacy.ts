// SPDX-License-Identifier: AGPL-3.0-only
//
// A client's privacy settings (C60, CS-7.40), stored once on the client record
// (migration 20261003000423), the written requests for model use kept beside
// it, and the one check an edit run (C77, C78) calls.
//
// The checks fail closed: a client this business does not hold, a provider
// not named, a cloud provider while no local-model path exists (owner line
// 72), or a provider with no assessed row on the overseas-services register
// (0052, APP 8.1) is each refused, and "no agent edits" (owner line O2)
// refuses every edit run whatever the egress says.

import type { TenantQuery } from '../tenancy/database.ts';

/** The providers a client's setting may name. `replay` is the tests' stand-in, not a cloud model. */
export const MODEL_PROVIDERS = ['claude', 'chatgpt', 'replay'] as const;

/** Overseas cloud models: refused for client content while no local-model path exists. */
export const CLOUD_PROVIDERS: readonly string[] = ['claude', 'chatgpt'];

export interface ClientPrivacy {
  readonly modelEgress: boolean;
  readonly providers: readonly string[];
  readonly handlesHealth: boolean;
  readonly noAgentEdits: boolean;
}

export type ClientUse =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'CLIENT_MODEL_USE_OFF'
        | 'CLIENT_NO_AGENT_EDITS'
        | 'LOCAL_MODEL_REQUIRED'
        | 'PROVIDER_NOT_ASSESSED';
    };

/** What came of a written request: applied, or the refusal's code. */
export type RequestOutcome =
  'applied' | 'LOCAL_MODEL_REQUIRED' | 'PROVIDER_NOT_ASSESSED' | 'CLIENT_HANDLES_HEALTH';

/** A client's written request for model use, as the command checked it. */
export interface ModelRequest {
  readonly clientId: string;
  readonly requestedBy: string;
  readonly requestedOn: string;
  readonly requestLink: string;
  readonly providers: readonly string[];
}

const SETTINGS = `model_egress as "modelEgress", model_providers as providers,
  handles_health as "handlesHealth", no_agent_edits as "noAgentEdits"`;

/** The client's settings, locked for a change when `lock`, or undefined for no client of this business. */
export async function readClientPrivacy(
  tx: TenantQuery,
  clientId: string,
  lock = false,
): Promise<ClientPrivacy | undefined> {
  const rows = await tx.query<ClientPrivacy>(
    `select ${SETTINGS} from public.clients where business_id = $1 and id = $2::uuid
       ${lock ? 'for update' : ''}`,
    [tx.businessId, clientId],
  );
  return rows[0];
}

/** Every client's settings, for Settings ▸ Access. */
export async function listClientPrivacy(
  tx: TenantQuery,
): Promise<readonly (ClientPrivacy & { readonly clientId: string })[]> {
  return await tx.query<ClientPrivacy & { readonly clientId: string }>(
    `select id as "clientId", ${SETTINGS} from public.clients
      where business_id = $1 order by lower(name), id`,
    [tx.businessId],
  );
}

/** Whether the overseas-services register holds an assessed row in use for this provider. */
export async function isProviderAssessed(tx: TenantQuery, provider: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.overseas_services
      where business_id = $1 and lower(service) = lower($2) and in_use and not to_confirm`,
    [tx.businessId, provider],
  );
  return rows.length === 1;
}

/** Whether this client's material may go to `provider` now: the egress half of the check. */
export async function checkClientModelUse(
  tx: TenantQuery,
  clientId: string,
  provider: string,
): Promise<ClientUse> {
  const privacy = await readClientPrivacy(tx, clientId);
  if (privacy === undefined || !privacy.modelEgress || !privacy.providers.includes(provider)) {
    return { ok: false, code: 'CLIENT_MODEL_USE_OFF' };
  }
  if (CLOUD_PROVIDERS.includes(provider)) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  if (!(await isProviderAssessed(tx, provider))) {
    return { ok: false, code: 'PROVIDER_NOT_ASSESSED' };
  }
  return { ok: true };
}

/**
 * The one check an edit run calls (C77, C78): refused while "no agent edits"
 * is on, and otherwise only where model egress allows the run's provider.
 */
export async function checkClientEditRun(
  tx: TenantQuery,
  clientId: string,
  provider: string,
): Promise<ClientUse> {
  const privacy = await readClientPrivacy(tx, clientId);
  if (privacy?.noAgentEdits === true) return { ok: false, code: 'CLIENT_NO_AGENT_EDITS' };
  return await checkClientModelUse(tx, clientId, provider);
}

/** What a written request comes to: the first refusal that holds, or applied. */
export async function judgeModelRequest(
  tx: TenantQuery,
  providers: readonly string[],
  handlesHealth: boolean,
): Promise<RequestOutcome> {
  if (providers.some((provider) => CLOUD_PROVIDERS.includes(provider))) {
    return 'LOCAL_MODEL_REQUIRED';
  }
  if (handlesHealth) return 'CLIENT_HANDLES_HEALTH';
  for (const provider of providers) {
    // oxlint-disable-next-line no-await-in-loop -- one register row per provider, at most three
    if (!(await isProviderAssessed(tx, provider))) return 'PROVIDER_NOT_ASSESSED';
  }
  return 'applied';
}

/** Keep a written request with what came of it; written once. */
export async function recordModelRequest(
  tx: TenantQuery,
  request: ModelRequest,
  outcome: RequestOutcome,
  actorId: string,
): Promise<void> {
  await tx.query(
    `insert into public.client_model_requests
       (business_id, id, client_id, requested_by, requested_on, request_link, providers,
        outcome, recorded_by_actor)
     values ($1, gen_random_uuid(), $2, $3, $4::date, $5, $6, $7, $8)`,
    [
      tx.businessId,
      request.clientId,
      request.requestedBy,
      request.requestedOn,
      request.requestLink,
      request.providers,
      outcome,
      actorId,
    ],
  );
}

/** Store the four settings on the client record, already locked by the caller. */
export async function writeClientPrivacy(
  tx: TenantQuery,
  clientId: string,
  settings: ClientPrivacy,
): Promise<void> {
  await tx.query(
    `update public.clients
        set model_egress = $3, model_providers = $4, handles_health = $5, no_agent_edits = $6
      where business_id = $1 and id = $2`,
    [
      tx.businessId,
      clientId,
      settings.modelEgress,
      settings.providers,
      settings.handlesHealth,
      settings.noAgentEdits,
    ],
  );
}
