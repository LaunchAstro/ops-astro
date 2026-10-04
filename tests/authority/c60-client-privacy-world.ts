// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C60 client privacy tests open: C32's (`c32-clients-world.ts`),
// with the one command and the reads these tests call. Ada is alpha's owner
// and holds every key the surface declares, `privacy:manage` among them; Mia
// holds the task keys and nothing else; Noah holds nothing; Tia is a teammate
// with no grant; Bea is bravo's. `replay` is the tests' stand-in provider, not
// a cloud model; `claude` and `chatgpt` are the cloud ones (owner line 72).
// Every name, address and link below is made up.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import type { Answer } from '../acceptance/world.ts';
import { as, createClient, detailOf, harness, outcome } from './c32-clients-world.ts';

export {
  as,
  clientToken,
  createClient,
  credential,
  detailOf,
  give,
  harness,
  member,
  outcome,
  revoke,
  tia,
  tiaToken,
  useClientsWorld,
} from './c32-clients-world.ts';

/** Every setting off, as a new client has them. */
export const ALL_OFF = {
  modelEgress: false,
  providers: [],
  handlesHealth: false,
  noAgentEdits: false,
} as const;

/** A client's written request, as the command takes it beside the settings. */
export const request = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  requestedBy: 'Dana Example, practice manager',
  requestedOn: '2026-10-01',
  requestLink: 'https://files.example.test/requests/model-use.pdf',
  ...overrides,
});

/** `client.set_privacy` as `token` on `key`'s prefix: every setting sent each time. */
export const setPrivacy = async (
  clientId: string,
  settings: Readonly<Record<string, unknown>>,
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<Answer> =>
  await as(
    '/client/set_privacy',
    { operationId: randomUUID(), clientId, ...ALL_OFF, ...settings },
    token,
    key,
  );

/** A new client of alpha's, by a made-up name. */
export const newClient = async (label: string): Promise<string> =>
  await createClient(`${label} ${randomUUID().slice(0, 6)}`);

/** The overseas-services register row the APP 8.1 assessment rests on, for `service`. */
export const assess = async (service: string, inUse = true, key = 'alpha'): Promise<void> => {
  const token = key === 'alpha' ? harness.world.ada.token : harness.world.bea.token;
  const answer = await as(
    '/privacy/set_overseas_service',
    {
      operationId: randomUUID(),
      service,
      receives: 'made-up client material',
      where: 'this installation',
      trainsOnIt: 'no',
      contract: 'a made-up business agreement',
      toConfirm: false,
      inUse,
    },
    token,
    key,
  );
  expect(outcome(answer), `assess ${service}`).toEqual({ status: 200, code: 'ok' });
};

export interface PrivacyRow {
  readonly modelEgress: boolean;
  readonly providers: readonly string[];
  readonly handlesHealth: boolean;
  readonly noAgentEdits: boolean;
}

/** The client's settings, read from the client record itself. */
export const clientRow = async (
  clientId: string,
  business: string = harness.world.alpha,
): Promise<PrivacyRow | undefined> => {
  const rows = await harness.world.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ readonly row: PrivacyRow }>(
        `select jsonb_build_object('modelEgress', c.model_egress, 'providers', c.model_providers,
                  'handlesHealth', c.handles_health, 'noAgentEdits', c.no_agent_edits) as row
           from public.clients c where c.id = $1`,
        [clientId],
      ),
  );
  return rows[0]?.row;
};

export interface RequestRow {
  readonly requestedBy: string;
  readonly requestedOn: string;
  readonly requestLink: string;
  readonly providers: readonly string[];
  readonly outcome: string;
}

/** The client's written requests for model use, oldest first. */
export const requestsOf = async (
  clientId: string,
  business: string = harness.world.alpha,
): Promise<readonly RequestRow[]> =>
  await harness.world.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<RequestRow>(
        `select requested_by as "requestedBy", requested_on::text as "requestedOn",
                request_link as "requestLink", providers, outcome
           from public.client_model_requests where client_id = $1
          order by recorded_at, id`,
        [clientId],
      ),
  );

/** The client's settings on `access.read`, Settings ▸ Access's one read. */
export const privacyOnAccess = async (
  clientId: string,
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<unknown> => {
  const answer = await as('/access/read', {}, token, key);
  expect(answer.status, 'access.read').toBe(200);
  const listed = (answer.body['clientPrivacy'] ?? []) as readonly { clientId: string }[];
  return listed.find((each) => each.clientId === clientId);
};

/** The applied change's detail, after checking it applied. */
export const appliedDetail = (answer: Answer, what: string): Record<string, unknown> => {
  expect(outcome(answer), what).toEqual({ status: 200, code: 'ok' });
  return detailOf(answer);
};

/** A statement run in alpha's tenancy, as the application role. */
export const onAlpha = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await harness.world.db.app.withBusiness(harness.world.alpha, run);
