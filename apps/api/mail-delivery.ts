// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker, as the API's composition root starts it: what
// makes inbox mail go out (`email-worker.ts`), over the deployment's
// businesses, each under its active worker actor.
//
// **Mock only, and said so.** There is no provider account yet (owner line
// 68: not now), so `MAIL_DELIVERY` is `off` (the default) or `mock`: the
// fake provider's outbox stands in for the inbox, as staging's owner check
// asks. Under `mock` three things are made up, each labelled `mock`: the
// provider, the sending subdomain's setup check (`fakeSenderSource`, verified
// for the subdomain `MAIL_FROM` names) and every person's email choice
// (MP-2-11's setting is not in yet; anything not told at once waits for the
// daily batch). A real provider is a new switch value with a real sender
// source, never `mock` pointed elsewhere: mock takes a provider on this machine only.
//
// **Delivery is custody's egress**, as the trace export's is: a custody
// process of its own holds the provider key for the one `email` destination,
// and the worker sends only through the broker's catalogued `email.send`.
// The settings are read like the trace export's: on with one missing or
// malformed, the server stops naming the setting and never its value.

import {
  catalogue,
  checkSender,
  EMAIL_SEND,
  emailAdapter,
  fakeSenderSource,
  RESEND_DESTINATION,
  type SenderReport,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseDestinations,
  startCustody,
  startMailWorker,
  type Broker,
  type Custody,
  type Destination,
  type EmailPreferences,
  type MailCadence,
  type MailSettings,
  type MailTarget,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

export const MAIL_DELIVERY_SWITCH = 'MAIL_DELIVERY';
export const MAIL_DELIVERY_SETTINGS = [
  'MAIL_PROVIDER_ORIGIN',
  'MAIL_CREDENTIALS_FILE',
  'MAIL_APP_ORIGIN',
  'MAIL_FROM',
] as const;

/** The provider key's reference in custody's credentials file, for the `email` destination. */
export const MAIL_CREDENTIAL = 'email_key';

export type MailDeliverySettings =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'mock';
      readonly destination: Destination;
      readonly credentialsFile: string;
      readonly appOrigin: string;
      readonly from: string;
      readonly subdomain: string;
    }
  | { readonly kind: 'invalid'; readonly problem: string };

/** Every person's email choice while MP-2-11's setting is not in: made up, and marked so. */
export const MOCK_PREFERENCES: EmailPreferences = {
  mock: true,
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

export function mailDeliverySettings(
  environment: Readonly<Record<string, string | undefined>>,
): MailDeliverySettings {
  const toggle = environment[MAIL_DELIVERY_SWITCH] ?? '';
  if (toggle === '' || toggle === 'off') return { kind: 'off' };
  if (toggle !== 'mock') {
    return invalid(`${MAIL_DELIVERY_SWITCH} is neither off nor mock (no provider account yet)`);
  }
  const value = (name: (typeof MAIL_DELIVERY_SETTINGS)[number]): string => environment[name] ?? '';
  const missing = MAIL_DELIVERY_SETTINGS.filter((name) => value(name) === '');
  if (missing.length > 0)
    return invalid(`mail delivery is mock but not set: ${missing.join(', ')}`);
  // A made-up sender check may only ever reach a made-up provider on this machine.
  const origin = onThisMachine(originOf(value('MAIL_PROVIDER_ORIGIN')));
  const parsed = parseDestinations([{ key: RESEND_DESTINATION.key, origin }]);
  const destination = parsed.ok ? parsed.destinations.get(RESEND_DESTINATION.key) : undefined;
  if (origin === undefined || destination === undefined) {
    return invalid(
      'MAIL_PROVIDER_ORIGIN is not a bare origin on this machine (mock reaches no real provider)',
    );
  }
  const appOrigin = originOf(value('MAIL_APP_ORIGIN'));
  if (appOrigin === undefined) {
    return invalid('MAIL_APP_ORIGIN is not a bare https origin (or http on this machine)');
  }
  const subdomain = ADDRESS.exec(value('MAIL_FROM'))?.[1];
  if (subdomain === undefined) {
    return invalid(
      'MAIL_FROM is not an address on a sending subdomain (a name at a sending subdomain, such as send.<your domain>)',
    );
  }
  return {
    kind: 'mock',
    destination,
    credentialsFile: value('MAIL_CREDENTIALS_FILE'),
    appOrigin,
    from: value('MAIL_FROM'),
    subdomain,
  };
}

/** Each business with its active worker actor; one without is skipped until it has one. */
async function targetsOf(
  database: Database,
  businesses: readonly BusinessId[],
): Promise<MailTarget[]> {
  const targets: MailTarget[] = [];
  for (const businessId of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business after another
    const [worker] = await database.withBusiness(
      businessId,
      async (tx) =>
        await tx.query<{ readonly id: string }>(
          `select id from public.actors
            where business_id = $1 and kind = 'worker' and active order by id limit 1`,
          [tx.businessId],
        ),
    );
    if (worker !== undefined) targets.push({ businessId, workerActorId: worker.id });
  }
  return targets;
}

/** The made-up setup check: verified for the subdomain `MAIL_FROM` names, its report marked mock. */
async function mockSender(subdomain: string): Promise<SenderReport> {
  const verified = { dkim: 'verified', spf: 'verified', returnPathMx: 'verified' };
  const source = fakeSenderSource({ name: subdomain, ...verified, dmarc: ['v=DMARC1; p=none'] });
  return await checkSender(source, subdomain, subdomain.slice(subdomain.indexOf('.') + 1));
}

/** The broker over custody: `email.send` alone, on the one `email` route. */
function mailBroker(custody: Custody): Broker {
  return {
    custody,
    operations: catalogue([EMAIL_SEND]),
    providers: new Map([[EMAIL_SEND.provider, { build: emailAdapter, price: () => 0 }]]),
    routes: [
      {
        key: RESEND_DESTINATION.key,
        reach: 'cloud',
        provider: EMAIL_SEND.provider,
        credentialRef: MAIL_CREDENTIAL,
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: EMAIL_SEND.concurrency,
      },
    ],
    installation: 'here',
    // The email path records its attempts on the inbox item, never through the model audit.
    audit: async () => {},
  };
}

/** Custody's own process for the provider, the broker over it, and the worker's two passes. */
export async function startMailDelivery(
  settings: Extract<MailDeliverySettings, { kind: 'mock' }>,
  database: Database,
  businesses: () => Promise<readonly BusinessId[]>,
  cadence: MailCadence = {},
): Promise<{
  readonly stop: () => Promise<void>;
  /** The broker and the mail settings, lent to the login provider's hook (C40). */
  readonly sending: { readonly broker: Broker; readonly mail: MailSettings };
}> {
  const sender = await mockSender(settings.subdomain);
  const custody = await startCustody({
    credentialsFile: settings.credentialsFile,
    destinations: [settings.destination],
  });
  const timing = {
    broker: mailBroker(custody),
    mail: { appOrigin: settings.appOrigin, from: settings.from, sender },
    preferences: MOCK_PREFERENCES,
  };
  const worker = startMailWorker(
    database,
    async () => await targetsOf(database, await businesses()),
    timing,
    cadence,
  );
  return {
    sending: { broker: timing.broker, mail: timing.mail },
    // The pass running ends first: custody stopped under a send would leave it unknown.
    stop: async () => {
      await worker.stop();
      await custody.stop();
    },
  };
}
