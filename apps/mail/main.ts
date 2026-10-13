// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 mail unit (on-email rules): one long-running process per environment,
// beside the forwarder, that holds the mail provider's key in custody and
// sends inbox mail and owed invitations. The API runs as a hosted function,
// which can hold no custody, so this is where mail leaves from.
//
//   node apps/mail/main.ts
//
// `MAIL_DELIVERY` off: it starts nothing and exits 0. On, it needs its own
// database login (`DATABASE_MAIL_URL`, a member of the app's group role
// alone), the lookup login (`DATABASE_LOOKUP_URL`, business ids and keys
// alone) and the deployment's business keys (`RECOVERY_BUSINESS_KEYS`, the
// function's own setting), resolved once at start. It refuses to start
// beside a login or key held elsewhere (`HELD_ELSEWHERE`, the function's
// list). It runs no HTTP listener, no recovery and no sweep: the function
// owns those.
//
// Under `mock` (staging) it starts the fake provider on this machine itself
// and saves each accepted message's body, never its headers, to
// `MAIL_MOCK_OUTBOX`, or by default to a file in a private folder it makes
// on its own temporary storage, so no other account's file is written. Under
// `resend` it reads the root's DMARC record through DNS: the one network
// primitive here, and it carries no key.
//
// SIGTERM or SIGINT stops the passes, waits for a send in flight, then stops
// custody and closes the logins. A problem names its setting, never a value.

import { appendFileSync, mkdtempSync } from 'node:fs';
import { resolveTxt } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeEmailProvider } from '../../packages/core-connectors/src/index.ts';
import {
  connect,
  connectAsAdmin,
  isBusinessId,
  type BusinessId,
} from '../../packages/core-records/src/index.ts';
import { mailDeliverySettings, startMailDelivery } from '../api/mail-delivery.ts';
import { createBusinessResolver } from '../api/server.ts';
import { mailUnitSettings, type Environment } from './settings.ts';

const stopWith = (problem: string): never => {
  console.error(`mail: ${problem}`);
  process.exit(1);
};

/** The fake provider on this machine, its accepted bodies (never headers) saved to the outbox file. */
async function startMockOutbox(
  environment: Environment,
): Promise<Awaited<ReturnType<typeof startFakeEmailProvider>>> {
  const outbox =
    environment['MAIL_MOCK_OUTBOX'] ||
    join(mkdtempSync(join(tmpdir(), 'ops-astro-mail-outbox-')), 'outbox.jsonl');
  console.log(`mail: mock outbox at ${outbox}`);
  return await startFakeEmailProvider({
    onAccept: (body) => {
      appendFileSync(outbox, `${body}\n`, { mode: 0o600 });
    },
  });
}

/** The deployment's business keys to ids, once, as the lookup identity; an unknown key is named. */
async function resolveKeys(lookupUrl: string, keys: readonly string[]): Promise<BusinessId[]> {
  const lookup = connectAsAdmin(lookupUrl, { source: 'lookup' });
  const resolve = createBusinessResolver(lookup);
  const businesses: BusinessId[] = [];
  try {
    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop -- one key at a time, once, at start
      const id = await resolve(key);
      if (id !== undefined && isBusinessId(id)) businesses.push(id);
      else console.error(`mail: business key ${key} resolves to no business; it gets no mail`);
    }
  } finally {
    await lookup.close();
  }
  return businesses;
}

async function main(): Promise<void> {
  const environment = process.env;
  const unit = mailUnitSettings(environment);
  if (!unit.ok) return stopWith(unit.problem);
  if (unit.kind === 'off') {
    console.log('mail: delivery off; nothing started');
    return;
  }
  const fake =
    environment['MAIL_DELIVERY'] === 'mock' ? await startMockOutbox(environment) : undefined;
  const mail = mailDeliverySettings(
    fake === undefined ? environment : { ...environment, MAIL_PROVIDER_ORIGIN: fake.origin },
  );
  if (mail.kind === 'invalid' || mail.kind === 'off') {
    await fake?.close();
    return stopWith(mail.kind === 'off' ? 'mail delivery is off' : mail.problem);
  }
  const businesses = await resolveKeys(unit.lookupUrl, unit.keys);
  const database = connect(unit.databaseUrl);
  let delivery: Awaited<ReturnType<typeof startMailDelivery>>;
  try {
    delivery = await startMailDelivery(
      mail,
      database,
      async () => await Promise.resolve(businesses),
      {},
      undefined,
      resolveTxt,
    );
  } catch (error) {
    await Promise.allSettled([database.close(), fake?.close()]);
    return stopWith((error as Error).message);
  }
  console.log(
    mail.kind === 'mock'
      ? 'mail: delivery mock (fake provider on this machine, made-up sender check and email choices)'
      : 'mail: delivery resend (default email choices until people set their own)',
  );
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await delivery.stop();
    await Promise.allSettled([database.close(), fake?.close()]);
    console.log('mail: stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

// Only as the process's entry. An import, a test's included, starts nothing.
if (import.meta.main) await main();
