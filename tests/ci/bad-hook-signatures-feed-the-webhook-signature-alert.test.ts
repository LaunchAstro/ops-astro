// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2: each signed inbound receiver, the email provider's delivery hook
// (AW-07b) and the login provider's Send Email hook (C39-T), makes every
// request it refuses for its signature a webhook-signature-failed signal:
// wrong key, tampered body, stale or missing headers. The signal names the
// source and no business (a hook runs outside any), never the body, a header
// or the secret. A correctly signed request is no signal, and five refusals
// in the window raise the alert. No database: the deployment here has no
// businesses, so a verified request is answered without a statement.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createDetector, type SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { AUTH_EMAIL_HOOK_PATH, mountAuthEmailHook } from '../../apps/api/auth-email-hook.ts';
import { MAIL_HOOK_PATH, mountMailHook } from '../../apps/api/mail-hook.ts';
import type { Broker, MailSettings } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const OTHER = `whsec_${randomBytes(24).toString('base64')}`;
const NOW = Math.floor(Date.now() / 1000);
type Observe = (signal: SecuritySignal) => void;

const RECEIVERS = [
  {
    source: 'email-hook',
    path: MAIL_HOOK_PATH,
    prefix: 'svix',
    good: 404,
    body: JSON.stringify({ type: 'email.delivered', data: { email_id: randomUUID() } }),
    mount: (app: Hono, observe: Observe) => {
      mountMailHook(app, {} as Database, {
        secret: SECRET,
        businesses: async () => await Promise.resolve([]),
        now: () => NOW * 1000,
        observe,
      });
    },
  },
  {
    source: 'auth-email-hook',
    path: AUTH_EMAIL_HOOK_PATH,
    prefix: 'webhook',
    good: 200,
    body: JSON.stringify({
      user: { id: randomUUID(), aud: 'authenticated', email: 'pat@example.test' },
      email_data: {
        token: '305805',
        token_hash: randomBytes(28).toString('hex'),
        redirect_to: 'https://ops.example.test',
        email_action_type: 'recovery',
        site_url: 'https://ops.example.test',
        token_new: '',
        token_hash_new: '',
      },
    }),
    mount: (app: Hono, observe: Observe) => {
      mountAuthEmailHook(app, {} as Database, {
        secret: SECRET,
        businesses: async () => await Promise.resolve([]),
        broker: {} as Broker,
        mail: {} as MailSettings,
        now: () => NOW * 1000,
        observe,
      });
    },
  },
] as const;

type Receiver = (typeof RECEIVERS)[number];

/** The Standard Webhooks headers over `<id>.<timestamp>.<body>`, written from the scheme. */
function signed(receiver: Receiver, over: string, secret = SECRET, at = NOW) {
  const id = randomUUID();
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${id}.${String(at)}.${over}`)
    .digest('base64');
  const { prefix } = receiver;
  return {
    [`${prefix}-id`]: id,
    [`${prefix}-timestamp`]: String(at),
    [`${prefix}-signature`]: `v1,${mac}`,
  };
}

function hook(receiver: Receiver, observe?: Observe): { app: Hono; seen: SecuritySignal[] } {
  const app = new Hono();
  const seen: SecuritySignal[] = [];
  receiver.mount(app, observe ?? ((signal) => seen.push(signal)));
  return { app, seen };
}

async function post(app: Hono, path: string, text: string, headers: Record<string, string>) {
  const request = new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: text,
  });
  return (await app.fetch(request)).status;
}

for (const receiver of RECEIVERS) {
  const { source, path, body } = receiver;

  describe(`the ${source} receiver`, () => {
    it('a bad signature is a webhook-signature-failed signal naming the source only', async () => {
      const { app, seen } = hook(receiver);
      const planted = [
        [body, signed(receiver, body, OTHER)],
        [`${body} `, signed(receiver, body)],
        [body, signed(receiver, body, SECRET, NOW - 3600)],
        [body, {}],
      ] as const;
      for (const [text, headers] of planted) {
        // oxlint-disable-next-line no-await-in-loop -- one planted request at a time
        expect(await post(app, path, text, headers)).toBe(401);
      }
      expect(seen).toEqual(
        planted.map(() => ({ kind: 'webhook-signature-failed', business: '', source })),
      );
      const told = JSON.stringify(seen);
      for (const part of [body.slice(0, 12), SECRET.slice(6), OTHER.slice(6), 'v1,']) {
        expect(told).not.toContain(part);
      }
    });

    it('a correctly signed request is no signal', async () => {
      const { app, seen } = hook(receiver);
      expect(await post(app, path, body, signed(receiver, body))).toBe(receiver.good);
      expect(seen).toEqual([]);
    });

    it('five bad signatures raise the webhook signature alert', async () => {
      const raised: string[] = [];
      const { app } = hook(receiver, createDetector((kind) => raised.push(kind)).observe);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one planted request at a time
        await post(app, path, body, signed(receiver, body, OTHER));
      }
      expect(raised).toEqual(['webhook-signature-failures']);
    });
  });
}
