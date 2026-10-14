// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker, as a composition root starts it: what makes inbox
// mail and owed invitations go out (`email-worker.ts`), over the deployment's
// businesses, each under its active worker actor. The M5 mail unit
// (`apps/mail/main.ts`) starts it for both values below; the API's own
// `main` starts `mock` only, so the API process never holds the real key.
//
// `MAIL_DELIVERY` is `off` (the default), `mock` or `resend`. The two starts
// share no path: `mock` never starts real custody or reads a credentials
// file, and `resend` never starts the loopback mock.
//
// **`mock`.** The fake provider's outbox stands in for the inbox, as staging's
// owner check asks. Three things are made up, each labelled `mock`: the
// provider, the sending subdomain's setup check (`fakeSenderSource`, verified
// for the subdomain `MAIL_FROM` names) and every person's email choice. Mock
// custody runs over a credentials file this module writes, holding a random
// key of its own, so a real file set by mistake is refused, never read. Mock
// takes a provider on this machine only, and the send accepts the mock report
// only over the custody core-custody started for that loopback provider
// (`startLoopbackMockCustody`). Mock records each send as `mock:<id>`, so it
// runs only where `OPS_ENVIRONMENT`, the deployment's own marker, is unset or
// exactly `staging`: over real people's items it would mark mail sent that no
// one received.
//
// **`resend`.** Real custody over `MAIL_CREDENTIALS_FILE`, which must hold the
// provider key `email_key` for the `email` destination, and nothing starts
// until it does. The provider's address is the code's; custody presents the
// key on POST `/emails` and GET `/domains/<MAIL_DOMAIN_ID>` alone. The sender
// check reads that domain through custody. Until MP-2-11's setting exists,
// every person's choice is owner answer 10's default: decisions and incidents
// at once, everything else in the daily batch. The source says so, and is not
// mock.
//
// **Delivery is custody's egress**, as the trace export's is, and the worker
// sends only through the broker's catalogued `email.send`. The settings are
// read like the trace export's: one missing or malformed stops the start,
// naming the setting and never its value. The sender check runs again at
// every pass, and before a send once its report is half its freshness old.

import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  custodySenderSource,
  startCustody,
  startLoopbackMockCustody,
  startMailWorker,
  type Broker,
  type Custody,
  type Destination,
  type EmailTiming,
  type MailCadence,
  type MailTarget,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import {
  DEFAULT_PREFERENCES,
  MAIL_CREDENTIAL,
  MOCK_PREFERENCES,
  rootOf,
  type MailDeliverySettings,
  type Started,
} from './mail-settings.ts';

export {
  DEFAULT_PREFERENCES,
  MAIL_CREDENTIAL,
  MAIL_DELIVERY_SWITCH,
  mailDeliverySettings,
  MOCK_MAIL_SETTINGS,
  MOCK_PREFERENCES,
  RESEND_MAIL_SETTINGS,
  type MailDeliverySettings,
} from './mail-settings.ts';

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
  return await checkSender(source, subdomain, rootOf(subdomain));
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

/**
 * Mock custody over a credentials file of its own, holding a random key. Custody reads its file
 * once, at load, so the file is removed as soon as custody has started.
 */
async function startMockCustody(destination: Destination): Promise<Custody> {
  const folder = mkdtempSync(join(tmpdir(), 'ops-astro-mail-mock-'));
  try {
    const credentialsFile = join(folder, 'credentials.json');
    const made = {
      ref: MAIL_CREDENTIAL,
      kind: 'api_key',
      account: 'mock',
      destination: destination.key,
      header: 'authorization',
      value: randomBytes(32).toString('hex'),
    };
    writeFileSync(credentialsFile, JSON.stringify([made]), { mode: 0o600 });
    return await startLoopbackMockCustody(credentialsFile, destination);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Real custody over the provider key, refusing to start unless the file can be read and holds
 * `email_key` for `email` as the provider reads a key: an `api_key`, presented as a bearer token.
 * The file is checked for access here and read by custody alone.
 */
async function startProviderCustody(
  settings: Extract<MailDeliverySettings, { kind: 'resend' }>,
): Promise<Custody> {
  try {
    accessSync(settings.credentialsFile, constants.R_OK);
  } catch {
    throw new Error('MAIL_CREDENTIALS_FILE cannot be read');
  }
  const custody = await startCustody({
    credentialsFile: settings.credentialsFile,
    destinations: [settings.destination],
  });
  const carrier = await custody.describe(MAIL_CREDENTIAL, settings.destination.key);
  if (
    carrier === null ||
    !carrier.presents ||
    carrier.scheme !== 'bearer' ||
    carrier.credentialKind !== 'api_key'
  ) {
    await custody.stop();
    throw new Error(
      `MAIL_CREDENTIALS_FILE holds no bearer api_key ${MAIL_CREDENTIAL} for the ${settings.destination.key} destination`,
    );
  }
  return custody;
}

/**
 * Custody's own process for the provider, the broker over it, and the worker's passes. The sender
 * check is run at the start of every pass: `mockSender` under mock, the provider's domain read
 * through custody under resend (with `txt`, the root's TXT reader), unless a test hands in its
 * own `senderCheck`.
 */
export async function startMailDelivery(
  settings: Started,
  database: Database,
  businesses: () => Promise<readonly BusinessId[]>,
  cadence: MailCadence = {},
  senderCheck?: (subdomain: string) => Promise<SenderReport>,
  txt?: (name: string) => Promise<string[][]>,
): Promise<{ readonly stop: () => Promise<void> }> {
  const custody =
    settings.kind === 'mock'
      ? await startMockCustody(settings.destination)
      : await startProviderCustody(settings);
  const check =
    senderCheck ??
    (settings.kind === 'mock'
      ? mockSender
      : async (subdomain: string) => {
          if (txt === undefined) throw new Error('resend: no TXT reader for the DMARC record');
          const read = {
            credentialRef: MAIL_CREDENTIAL,
            destination: settings.destination.key,
            domainId: settings.domainId,
          };
          const source = custodySenderSource(custody, read, txt);
          return await checkSender(source, subdomain, rootOf(subdomain));
        });
  const broker = mailBroker(custody);
  const timing = async (): Promise<EmailTiming> => ({
    broker,
    mail: {
      appOrigin: settings.appOrigin,
      from: settings.from,
      sender: await check(settings.subdomain),
    },
    preferences: settings.kind === 'mock' ? MOCK_PREFERENCES : DEFAULT_PREFERENCES,
  });
  const worker = startMailWorker(
    database,
    async () => await targetsOf(database, await businesses()),
    timing,
    cadence,
  );
  return {
    // The pass running ends first: custody stopped under a send would leave it unknown.
    stop: async () => {
      await worker.stop();
      await custody.stop();
    },
  };
}
