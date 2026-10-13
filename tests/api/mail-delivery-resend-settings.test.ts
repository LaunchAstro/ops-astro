// SPDX-License-Identifier: AGPL-3.0-only
//
// The real provider's switch value. `MAIL_DELIVERY=resend` takes its key only
// from custody's credentials file, its provider address only from the code,
// and starts nothing unless that file holds the provider key for the mail
// destination. Each case starts from one otherwise valid configuration, so a
// refusal here is the credential's and nothing else's. The positive control
// points the provider at a loopback stand-in that counts what it hears: the
// start reads no key into this process and calls the provider not at all.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  mailDeliverySettings,
  RESEND_MAIL_SETTINGS,
  startMailDelivery,
} from '../../apps/api/mail-delivery.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const SENDING = 'send.example.test';
const domainId = randomUUID();
const canary = `canary-${randomBytes(18).toString('hex')}`;
const heard: string[] = [];
let server: Server;
let origin = '';
let folder = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    heard.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'mail-resend-settings-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

/** Every `resend` setting set and well formed; the credentials file is the case's own. */
const valid = (credentialsFile: string): Record<string, string> => ({
  MAIL_DELIVERY: 'resend',
  MAIL_CREDENTIALS_FILE: credentialsFile,
  MAIL_APP_ORIGIN: 'https://ops.example.test',
  MAIL_FROM: `hello@${SENDING}`,
  MAIL_DOMAIN_ID: domainId,
  OPS_EGRESS_MAIL_HOST: '127.0.0.1',
  OPS_ENVIRONMENT: 'production',
});

const fileWith = (name: string, entries: readonly Record<string, string>[]): string => {
  const path = join(folder, name);
  writeFileSync(path, JSON.stringify(entries), { mode: 0o600 });
  return path;
};

const entry = (ref: string, destination: string) => ({
  ref,
  kind: 'api_key',
  account: 'mail-1',
  destination,
  header: 'authorization',
  value: canary,
});

/** A database the start never reaches: no business, so no pass touches it. */
const noDatabase = {} as Database;
const noBusinesses = async (): Promise<readonly never[]> => await Promise.resolve([]);
const idle = { atOnceMs: 3_600_000, dailyTickMs: 3_600_000 };
const noTxt = async (): Promise<string[][]> => await Promise.resolve([]);

const start = async (environment: Record<string, string>) => {
  const settings = mailDeliverySettings(environment, origin);
  if (settings.kind !== 'resend') throw new Error(`not resend: ${JSON.stringify(settings)}`);
  return await startMailDelivery(settings, noDatabase, noBusinesses, idle, undefined, noTxt);
};

it('resend with every setting parses, the provider address from the code alone', () => {
  const settings = mailDeliverySettings(valid('/nowhere/credentials.json'), origin);
  expect(settings).toMatchObject({
    kind: 'resend',
    destination: {
      key: 'email',
      origin,
      posts: ['/emails'],
      routes: [{ method: 'GET', path: `/domains/${domainId}` }],
    },
    from: `hello@${SENDING}`,
    subdomain: SENDING,
  });
  for (const name of RESEND_MAIL_SETTINGS) {
    const missing = mailDeliverySettings({ ...valid('/x'), [name]: '' }, origin);
    expect(missing, name).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(missing)).toContain(name);
  }
  const refused: Record<string, string>[] = [
    { MAIL_PROVIDER_ORIGIN: 'http://127.0.0.1:9' },
    { MAIL_DOMAIN_ID: '../api-keys' },
    { OPS_EGRESS_MAIL_HOST: 'api.example.test' },
  ];
  for (const change of refused) {
    const settings2 = mailDeliverySettings({ ...valid('/x'), ...change }, origin);
    expect(settings2, JSON.stringify(change)).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(settings2)).toContain(Object.keys(change)[0] ?? '');
  }
});

it('a credentials file that is not there stops the start, naming the setting and nothing else', async () => {
  const missing = join(folder, 'absent.json');
  await expect(start(valid(missing))).rejects.toThrow(/^MAIL_CREDENTIALS_FILE cannot be read/u);
  await expect(start(valid(missing))).rejects.not.toThrow(new RegExp(folder, 'u'));
  expect(heard).toEqual([]);
});

it('a credentials file with no provider key for the mail destination stops the start, naming the key', async () => {
  const other = fileWith('other.json', [entry('trace_key', 'trace_target')]);
  await expect(start(valid(other))).rejects.toThrow(
    /^MAIL_CREDENTIALS_FILE holds no email_key for the email destination/u,
  );
  const elsewhere = fileWith('elsewhere.json', [entry('email_key', 'trace_target')]);
  await expect(start(valid(elsewhere))).rejects.toThrow(/holds no email_key/u);
  expect(heard).toEqual([]);
});

it('with the provider key filed, the start succeeds, holds no key here and calls the provider not at all', async () => {
  const filed = fileWith('filed.json', [entry('email_key', 'email')]);
  const delivery = await start(valid(filed));
  try {
    expect(heard).toEqual([]);
    expect(JSON.stringify(process.env)).not.toContain(canary);
  } finally {
    await delivery.stop();
  }
  expect(heard).toEqual([]);
});
