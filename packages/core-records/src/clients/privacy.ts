// SPDX-License-Identifier: AGPL-3.0-only
//
// WIP (C60, CS-7.40; migration 0222): a client's privacy settings on the
// client record, and the one check an edit run (C77, C78) calls. Not wired
// to a command, read or screen yet; see the lane report for the plan.
//
// The check fails closed: a client this business does not hold, a provider
// not named, a provider with no assessed row on the overseas-services
// register (0052, APP 8.1), or a cloud provider while no local-model path
// exists (owner line 72) is each refused, and "no agent edits" (owner line O2)
// refuses every edit run whatever the egress says.

import type { TenantQuery } from '../tenancy/database.ts';

/** The providers a client's setting may name. `replay` is the tests' stand-in, not a cloud model. */
export const MODEL_PROVIDERS = ['claude', 'chatgpt', 'replay'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Overseas cloud models: refused for client content while no local-model path exists. */
export const CLOUD_PROVIDERS: readonly ModelProvider[] = ['claude', 'chatgpt'];

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

/** The client's settings, locked for a change when `lock`, or undefined for no client of this business. */
export async function readClientPrivacy(
  tx: TenantQuery,
  clientId: string,
  lock = false,
): Promise<ClientPrivacy | undefined> {
  const rows = await tx.query<ClientPrivacy>(
    `select model_egress as "modelEgress", model_providers as providers,
            handles_health as "handlesHealth", no_agent_edits as "noAgentEdits"
       from public.clients where business_id = $1 and id = $2::uuid
       ${lock ? 'for update' : ''}`,
    [tx.businessId, clientId],
  );
  return rows[0];
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
  if ((CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  }
  if (!(await isProviderAssessed(tx, provider)))
    return { ok: false, code: 'PROVIDER_NOT_ASSESSED' };
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
