// SPDX-License-Identifier: AGPL-3.0-only
//
// The hook cases' helpers, over the AW-07b email world: the hook route
// mounted the way `composeApi` mounts it, on its own app, with a made-up hook
// secret and a clock a case can move; a signer that signs the Svix way,
// written here from the scheme rather than imported, so the route is checked
// against an independent signature; and a send that leaves one accepted
// attempt and returns the provider's message id.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { EMAIL_SUBJECT } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail } from '../../packages/core-custody/src/index.ts';
import { MAIL_HOOK_PATH, mountMailHook } from '../../apps/api/mail-hook.ts';
import { itemFor, MAIL, w } from './email-world.ts';

/** A made-up hook secret in the provider's form. Never a real credential. */
export const HOOK_SECRET: string = `whsec_${randomBytes(24).toString('base64')}`;

export const hook: { app: Hono; clock: number } = {
  app: new Hono(),
  /** The server's clock, in seconds; cases move it. */
  clock: Math.floor(Date.now() / 1000),
};

/** Mount the route over the world's database, the first business and the second in the deployment. */
export function mountHook(): void {
  hook.app = new Hono();
  mountMailHook(hook.app, w.db.app, {
    secret: HOOK_SECRET,
    businesses: async () => await Promise.resolve([w.alpha, w.bravo]),
    now: () => hook.clock * 1000,
  });
}

/** An event body as the provider sends it: the message id plus fields that carry the address. */
export function eventBody(type: string, messageId: string, extra: object = {}): string {
  return JSON.stringify({
    type,
    created_at: '2026-10-01T00:00:00.000Z',
    data: { email_id: messageId, to: [w.canary], subject: EMAIL_SUBJECT, ...extra },
  });
}

export interface Signed {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
}

/** The Svix signature over `<id>.<timestamp>.<raw bytes>`, under `secret`. */
export function sign(
  raw: Uint8Array | string,
  at: number = hook.clock,
  id = `msg_${randomUUID().replaceAll('-', '')}`,
  secret: string = HOOK_SECRET,
): Signed {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${id}.${String(at)}.`)
    .update(raw)
    .digest('base64');
  return { id, timestamp: String(at), signature: `v1,${mac}` };
}

/** POST to the route: signed headers (or a case's own), the body as given. */
export async function post(
  raw: Uint8Array | string,
  signed: Signed | null = sign(raw),
  headers: Headers = new Headers(),
): Promise<{ readonly status: number; readonly code: string; readonly text: string }> {
  if (signed !== null) {
    headers.set('svix-id', signed.id);
    headers.set('svix-timestamp', signed.timestamp);
    headers.set('svix-signature', signed.signature);
  }
  headers.set('content-type', 'application/json');
  const response = await hook.app.fetch(
    new Request(`http://api.test${MAIL_HOOK_PATH}`, {
      method: 'POST',
      headers,
      body: typeof raw === 'string' ? raw : new Uint8Array(raw),
    }),
  );
  const text = await response.text();
  const code = (JSON.parse(text) as { code?: string }).code ?? '';
  return { status: response.status, code, text };
}

/** Send one email on a fresh item; its id and the provider's message id. */
export async function sentItem(business?: {
  id: string;
  person: string;
  task: string;
}): Promise<{ readonly item: string; readonly messageId: string }> {
  const { id, person, task } = business ?? { id: w.alpha, person: w.person, task: w.task };
  w.provider.mode('accept');
  const item = await itemFor(task, 'mention', { id, person });
  const sent = await sendInboxEmail(w.db.app, id, item, w.broker, MAIL);
  if (!sent.ok) throw new Error(`hook world: the send was refused (${sent.code})`);
  const messageId = w.provider.outbox.at(-1)?.id;
  if (messageId === undefined) throw new Error('hook world: the outbox is empty');
  return { item, messageId };
}
