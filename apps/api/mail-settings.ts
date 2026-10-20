// SPDX-License-Identifier: AGPL-3.0-only
//
// The mail delivery switch and its settings (`mail-delivery.ts` starts what
// they name): `MAIL_DELIVERY` off, mock or resend, read from the environment.
// A setting missing or malformed is a problem naming the setting, never its
// value. Mock reaches a provider on this machine only and reads no
// credentials file; resend reaches the provider's own address only, through
// custody's exact routes, with its key in `MAIL_CREDENTIALS_FILE`.

import {
  checkableSender,
  RESEND_DESTINATION,
  resendDestination,
} from '../../packages/core-connectors/src/index.ts';
import {
  fromVerifiedSender,
  parseDestinations,
  type Destination,
  type EmailPreferences,
} from '../../packages/core-custody/src/index.ts';
import { isUuid } from '../../packages/core-records/src/index.ts';

export const MAIL_DELIVERY_SWITCH = 'MAIL_DELIVERY';
/** The deployment's marker (`deploy/staging/README.md`): `staging` or `production`. */
const DEPLOYMENT_MARKER = 'OPS_ENVIRONMENT';
/** What `mock` needs; `MAIL_CREDENTIALS_FILE` it refuses. */
export const MOCK_MAIL_SETTINGS = ['MAIL_PROVIDER_ORIGIN', 'MAIL_APP_ORIGIN', 'MAIL_FROM'] as const;
/** What `resend` needs; `MAIL_PROVIDER_ORIGIN` it refuses. */
export const RESEND_MAIL_SETTINGS = [
  'MAIL_CREDENTIALS_FILE',
  'MAIL_APP_ORIGIN',
  'MAIL_FROM',
  'MAIL_DOMAIN_ID',
  'OPS_EGRESS_MAIL_HOST',
] as const;

/** The provider key's reference in custody's credentials file, for the `email` destination. */
export const MAIL_CREDENTIAL = 'email_key';

interface Sending {
  readonly destination: Destination;
  readonly appOrigin: string;
  readonly from: string;
  readonly subdomain: string;
}

export type MailDeliverySettings =
  | { readonly kind: 'off' }
  | ({ readonly kind: 'mock' } & Sending)
  | ({
      readonly kind: 'resend';
      readonly credentialsFile: string;
      readonly domainId: string;
    } & Sending)
  | { readonly kind: 'invalid'; readonly problem: string };

export type Started = Extract<MailDeliverySettings, { kind: 'mock' | 'resend' }>;

/** Every person's email choice under `mock`: made up, and marked so. */
export const MOCK_PREFERENCES: EmailPreferences = {
  mock: true,
  choice: async () => await Promise.resolve('daily_batch'),
};

/**
 * Every person's email choice under `resend` until MP-2-11's setting exists: owner answer 10's
 * default, not anyone's own choice. Decisions and incidents go at once whatever this says.
 */
export const DEFAULT_PREFERENCES: EmailPreferences = {
  mock: false,
  choice: async () => await Promise.resolve('daily_batch'),
};

const invalid = (problem: string): MailDeliverySettings => ({ kind: 'invalid', problem });

/** Plain http only to this machine, as the trace export's target. */
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/u;
const ADDRESS = /^[^@\s]+@([a-z0-9-]+(?:\.[a-z0-9-]+){2,})$/u;

/** A bare origin, https or loopback http, or undefined. */
function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== value) return undefined;
    if (url.protocol === 'https:') return value;
    return url.protocol === 'http:' && LOOPBACK.test(url.hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

function onThisMachine(origin: string | undefined): string | undefined {
  return origin !== undefined && LOOPBACK.test(new URL(origin).hostname) ? origin : undefined;
}

/** The root a sending subdomain is set up under: everything after its first label. */
export const rootOf = (subdomain: string): string => subdomain.slice(subdomain.indexOf('.') + 1);

/**
 * The sending subdomain `from` is on, or undefined where the sender gate would refuse `from` or
 * the setup check could never verify its subdomain.
 */
function sendingSubdomain(from: string): string | undefined {
  const subdomain = ADDRESS.exec(from)?.[1];
  // The send's own address rule and the setup check's host rule, run once here, so a from
  // either would refuse stops the start rather than leave every email unsent.
  const accepted =
    subdomain !== undefined &&
    checkableSender(subdomain, rootOf(subdomain)) &&
    fromVerifiedSender(from, { verified: true, subdomain, mock: false });
  return accepted ? subdomain : undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The app's origin and the sender, both values share; a problem names the setting. */
function appAndSender(
  value: (name: string) => string,
): Omit<Sending, 'destination'> | MailDeliverySettings {
  const appOrigin = originOf(value('MAIL_APP_ORIGIN'));
  if (appOrigin === undefined) {
    return invalid('MAIL_APP_ORIGIN is not a bare https origin (or http on this machine)');
  }
  const subdomain = sendingSubdomain(value('MAIL_FROM'));
  if (subdomain === undefined) {
    return invalid(
      'MAIL_FROM is not an address the sender gate accepts (a dot-atom name of at most 64 octets, 254 in all, at a sending subdomain such as send.<your domain>, its labels letters, digits and inner hyphens)',
    );
  }
  return { appOrigin, from: value('MAIL_FROM'), subdomain };
}

function mockSettings(environment: Environment): MailDeliverySettings {
  // An allowlist: an empty or misspelt marker may be production, so it refuses mock.
  const where = environment[DEPLOYMENT_MARKER];
  if (where !== undefined && where !== 'staging') {
    return invalid(
      `${MAIL_DELIVERY_SWITCH} is mock where ${DEPLOYMENT_MARKER} is set but not staging (mock mail reaches no one)`,
    );
  }
  if ((environment['MAIL_CREDENTIALS_FILE'] ?? '') !== '') {
    return invalid(
      'MAIL_CREDENTIALS_FILE is set, but mock reads no credentials file (it makes up its own key)',
    );
  }
  const value = (name: string): string => environment[name] ?? '';
  const missing = MOCK_MAIL_SETTINGS.filter((name) => value(name) === '');
  if (missing.length > 0) {
    return invalid(`mail delivery is mock but not set: ${missing.join(', ')}`);
  }
  // A made-up sender check may only ever reach a made-up provider on this machine.
  const origin = onThisMachine(originOf(value('MAIL_PROVIDER_ORIGIN')));
  const parsed = parseDestinations([{ key: RESEND_DESTINATION.key, origin }]);
  const destination = parsed.ok ? parsed.destinations.get(RESEND_DESTINATION.key) : undefined;
  if (origin === undefined || destination === undefined) {
    return invalid(
      'MAIL_PROVIDER_ORIGIN is not a bare origin on this machine (mock reaches no real provider)',
    );
  }
  const sending = appAndSender(value);
  return 'kind' in sending ? sending : { kind: 'mock', destination, ...sending };
}

function resendSettings(environment: Environment, providerOrigin: string): MailDeliverySettings {
  const value = (name: string): string => environment[name] ?? '';
  const missing = RESEND_MAIL_SETTINGS.filter((name) => value(name) === '');
  if (missing.length > 0) {
    return invalid(`mail delivery is resend but not set: ${missing.join(', ')}`);
  }
  if (value('MAIL_PROVIDER_ORIGIN') !== '') {
    return invalid(
      "MAIL_PROVIDER_ORIGIN is set, but resend reaches the provider's own address only",
    );
  }
  const domainId = value('MAIL_DOMAIN_ID');
  if (!isUuid(domainId)) return invalid("MAIL_DOMAIN_ID is not the provider's id of a domain");
  if (value('OPS_EGRESS_MAIL_HOST') !== new URL(providerOrigin).hostname) {
    return invalid("OPS_EGRESS_MAIL_HOST is not the provider's host");
  }
  const parsed = parseDestinations([resendDestination(domainId, providerOrigin)]);
  const destination = parsed.ok ? parsed.destinations.get(RESEND_DESTINATION.key) : undefined;
  if (destination === undefined) return invalid('the provider destination did not load');
  const sending = appAndSender(value);
  if ('kind' in sending) return sending;
  return {
    kind: 'resend',
    credentialsFile: value('MAIL_CREDENTIALS_FILE'),
    domainId,
    destination,
    ...sending,
  };
}

/**
 * The switch and its settings. `providerOrigin` is the code's own address for `resend`; only a
 * test hands in another, a loopback stand-in.
 */
export function mailDeliverySettings(
  environment: Environment,
  providerOrigin: string = RESEND_DESTINATION.origin,
): MailDeliverySettings {
  const toggle = environment[MAIL_DELIVERY_SWITCH] ?? '';
  if (toggle === '' || toggle === 'off') return { kind: 'off' };
  if (toggle === 'mock') return mockSettings(environment);
  if (toggle === 'resend') return resendSettings(environment, providerOrigin);
  return invalid(`${MAIL_DELIVERY_SWITCH} is neither off, mock nor resend`);
}
