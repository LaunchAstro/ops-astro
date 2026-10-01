// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T's enrolment route as the API's composition root turns it on:
// `POST /api/enrol` (`enrolment.ts`) over the deployment's businesses and a
// broker that reaches the login provider's admin users route.
//
// **Off unless `ENROLMENT=on`.** On, the operator has staged the provider's
// bare origin (`ENROLMENT_AUTH_ORIGIN`, https unless it is on this machine:
// plain http would carry the service key in clear) and custody's credentials
// file (`ENROLMENT_CREDENTIALS_FILE`), holding the service key under
// `auth_key` for the `auth` destination. On with either missing or
// malformed, or any other value, the server stops before it listens, naming
// the setting and never its value, as the mail delivery's switch does; and so
// it does when the file holds no `auth_key` for `auth`, which custody checks.
//
// **The service key stays in custody.** A custody process of its own holds
// it; this process names the file and never reads it. The broker catalogues
// `auth.create_user`, `auth.read_user` and (C40) `auth.recover` and nothing
// else, and custody lets the `auth` destination take the create's POST on
// `/auth/v1/admin/users`, the read's GET on `/auth/v1/admin/users/<id>` and
// the reset's POST on `/auth/v1/recover`, no other method or path: no
// update, sign-in link, invite, code or factor route.

import {
  AUTH_CREATE_USER,
  AUTH_READ_USER,
  AUTH_RECOVER,
  AUTH_RECOVER_PATH,
  AUTH_USERS_PATH,
  authRecoverAdapter,
  authUserAdapter,
  authUserReadAdapter,
  catalogue,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseDestinations,
  startCustody,
  type Broker,
  type BrokerRoute,
  type Custody,
  type Destination,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { EnrolmentOptions } from './enrolment.ts';

export const ENROLMENT_SWITCH = 'ENROLMENT';
export const ENROLMENT_SETTINGS = ['ENROLMENT_AUTH_ORIGIN', 'ENROLMENT_CREDENTIALS_FILE'] as const;

/** The service key's reference in custody's credentials file, for the `auth` destination. */
export const AUTH_CREDENTIAL = 'auth_key';

export type EnrolmentSettings =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly destination: Destination; readonly credentialsFile: string }
  | { readonly kind: 'invalid'; readonly problem: string };

const invalid = (problem: string): EnrolmentSettings => ({ kind: 'invalid', problem });

/** Plain http only to this machine, as the trace export's target. */
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * The login provider as custody lists it: the origin, the create's one POST
 * and the read's GET, and the service key in `apikey` as well as the bearer,
 * as a hosted provider reads a secret key (`sb_secret_...`).
 */
export function authDestination(origin: string): Destination {
  return {
    key: AUTH_CREATE_USER.destination,
    origin,
    keyHeader: 'apikey',
    routes: [
      { method: 'POST', path: AUTH_USERS_PATH },
      { method: 'GET', path: `${AUTH_USERS_PATH}/*` },
      // C40 (ORCH60): a reset asked for one address, the provider mailing nothing itself.
      { method: 'POST', path: AUTH_RECOVER_PATH },
    ],
  };
}

export function enrolmentSettings(
  environment: Readonly<Record<string, string | undefined>>,
): EnrolmentSettings {
  const toggle = environment[ENROLMENT_SWITCH] ?? '';
  if (toggle === '' || toggle === 'off') return { kind: 'off' };
  if (toggle !== 'on') return invalid(`${ENROLMENT_SWITCH} is neither on nor off`);
  const value = (name: (typeof ENROLMENT_SETTINGS)[number]): string => environment[name] ?? '';
  const missing = ENROLMENT_SETTINGS.filter((name) => value(name) === '');
  if (missing.length > 0) return invalid(`enrolment is on but not set: ${missing.join(', ')}`);
  const parsed = parseDestinations([authDestination(value('ENROLMENT_AUTH_ORIGIN'))]);
  const destination = parsed.ok ? parsed.destinations.get(AUTH_CREATE_USER.destination) : undefined;
  if (destination === undefined) {
    return invalid('ENROLMENT_AUTH_ORIGIN is not a bare http(s) origin');
  }
  const { protocol, hostname } = new URL(destination.origin);
  if (protocol === 'http:' && !LOOPBACK.test(hostname)) {
    return invalid('ENROLMENT_AUTH_ORIGIN is plain http off this machine; use https');
  }
  return { kind: 'on', destination, credentialsFile: value('ENROLMENT_CREDENTIALS_FILE') };
}

/** One route per operation, each on the service key: adapters are found by provider. */
const route = (provider: string): BrokerRoute => ({
  key: provider,
  reach: 'cloud',
  provider,
  credentialRef: AUTH_CREDENTIAL,
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: AUTH_CREATE_USER.concurrency,
});

/** The broker over custody: `auth.create_user` and `auth.read_user`, nothing else. */
export function enrolmentBroker(custody: Custody): Broker {
  return {
    custody,
    operations: catalogue([AUTH_CREATE_USER, AUTH_READ_USER, AUTH_RECOVER]),
    providers: new Map([
      [AUTH_CREATE_USER.provider, { build: authUserAdapter, price: () => 0 }],
      [AUTH_READ_USER.provider, { build: authUserReadAdapter, price: () => 0 }],
      [AUTH_RECOVER.provider, { build: authRecoverAdapter, price: () => 0 }],
    ]),
    routes: [
      route(AUTH_CREATE_USER.provider),
      route(AUTH_READ_USER.provider),
      route(AUTH_RECOVER.provider),
    ],
    installation: 'here',
    // The accept records its own audit events in its transaction, never the model audit.
    audit: async () => {},
  };
}

/** Custody's own process for the login provider, and the route's options over it. */
export async function startEnrolment(
  settings: Extract<EnrolmentSettings, { kind: 'on' }>,
  businesses: () => Promise<readonly BusinessId[]>,
): Promise<{ readonly options: EnrolmentOptions; readonly stop: () => Promise<void> }> {
  // Without the service key for `auth` custody does not start, so the server stops before it listens.
  const custody = await startCustody({
    credentialsFile: settings.credentialsFile,
    destinations: [settings.destination],
    requires: [AUTH_CREDENTIAL],
  });
  return {
    options: { businesses, broker: enrolmentBroker(custody) },
    stop: async () => await custody.stop(),
  };
}
