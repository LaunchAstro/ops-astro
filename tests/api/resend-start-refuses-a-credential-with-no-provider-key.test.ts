// SPDX-License-Identifier: AGPL-3.0-only
//
// The real provider's start takes only a key it can present the way the
// provider reads one: an `email_key` for the `email` destination, of kind
// `api_key`, sent as a bearer token. One filed to present nothing (scheme
// `none`), one sent as a Basic pair, or one of another kind is no provider
// key: the start refuses it, naming `email_key` and never a value, and the
// provider stand-in hears nothing. A bearer `api_key` starts.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mailDeliverySettings, startMailDelivery } from '../../apps/api/mail-delivery.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

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
  folder = mkdtempSync(join(tmpdir(), 'resend-start-key-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

const base = { ref: 'email_key', account: 'mail-1', destination: 'email' };

async function startWith(name: string, entry: Record<string, string>) {
  const credentialsFile = join(folder, `${name}.json`);
  writeFileSync(credentialsFile, JSON.stringify([entry]), { mode: 0o600 });
  const settings = mailDeliverySettings(
    {
      MAIL_DELIVERY: 'resend',
      MAIL_CREDENTIALS_FILE: credentialsFile,
      MAIL_APP_ORIGIN: 'https://ops.example.test',
      MAIL_FROM: `hello${String.fromCodePoint(64)}send.example.test`,
      MAIL_DOMAIN_ID: randomUUID(),
      OPS_EGRESS_MAIL_HOST: '127.0.0.1',
    },
    origin,
  );
  if (settings.kind !== 'resend') throw new Error(`not resend: ${JSON.stringify(settings)}`);
  return await startMailDelivery(
    settings,
    {} as Database,
    async () => await Promise.resolve([]),
    { atOnceMs: 3_600_000, dailyTickMs: 3_600_000, invitationsMs: 3_600_000 },
    undefined,
    async () => await Promise.resolve([]),
  );
}

it('an email_key filed to present nothing, sent as a Basic pair, or of another kind stops the start', async () => {
  const refused: readonly [string, Record<string, string>][] = [
    ['presents-nothing', { ...base, kind: 'api_key', scheme: 'none' }],
    [
      'basic-pair',
      {
        ...base,
        kind: 'api_key',
        header: 'authorization',
        scheme: 'basic',
        value: `user:${canary}`,
      },
    ],
    ['other-kind', { ...base, kind: 'cloud_credential', header: 'authorization', value: canary }],
  ];
  for (const [name, entry] of refused) {
    // oxlint-disable-next-line no-await-in-loop -- one refusal after another
    await expect(startWith(name, entry), name).rejects.toThrow(
      /^MAIL_CREDENTIALS_FILE holds no bearer api_key email_key for the email destination$/u,
    );
  }
  expect(heard).toEqual([]);
});

it('a bearer api_key starts, and the provider hears nothing at start', async () => {
  const delivery = await startWith('bearer', {
    ...base,
    kind: 'api_key',
    header: 'authorization',
    value: canary,
  });
  await delivery.stop();
  expect(heard).toEqual([]);
});
