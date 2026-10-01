// SPDX-License-Identifier: AGPL-3.0-only
//
// The Auth email hook cases' helpers (C39-T, piece P2), over the invitation
// world: the route mounted the way `composeApi` mounts it, on its own app,
// with a made-up secret in the login provider's form (`v1,whsec_...`) and a
// clock a case can move; a signer that signs the Standard Webhooks way,
// written here from the scheme rather than imported, so the route is checked
// against an independent signature; and the provider's message body.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { AUTH_EMAIL_HOOK_PATH, mountAuthEmailHook } from '../../apps/api/auth-email-hook.ts';
import { MAIL, w } from './c39-t-world.ts';

/** A made-up hook secret in the login provider's form. Never a real credential. */
export const AUTH_HOOK_SECRET: string = `v1,whsec_${randomBytes(24).toString('base64')}`;

export const ah: { app: Hono; clock: number } = {
  app: new Hono(),
  /** The server's clock, in seconds; cases move it. */
  clock: Math.floor(Date.now() / 1000),
};

/** The route over the world, the deployment's businesses alpha and bravo unless named. */
export function mountAuthHook(businesses: readonly string[] = [w.alpha, w.bravo]): Hono {
  ah.app = new Hono();
  mountAuthEmailHook(ah.app, w.db.app, {
    secret: AUTH_HOOK_SECRET,
    businesses: async () => await Promise.resolve(businesses),
    broker: w.broker,
    mail: MAIL,
    now: () => ah.clock * 1000,
  });
  return ah.app;
}

/** A token hash in the provider's shape: 56 lower-case hex characters. */
export const tokenHash = (): string => randomBytes(28).toString('hex');

/** A message as the login provider sends it: the user, then what the email needs. */
export function authMessage(
  action: string,
  email: string,
  hash: string = tokenHash(),
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    user: { id: randomUUID(), aud: 'authenticated', email, user_metadata: {} },
    email_data: {
      token: '305805',
      token_hash: hash,
      redirect_to: 'https://ops.example.test',
      email_action_type: action,
      site_url: 'https://ops.example.test',
      token_new: '',
      token_hash_new: '',
      ...extra,
    },
  });
}

export interface Signed {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
}

/** The Standard Webhooks signature over `<id>.<timestamp>.<raw bytes>`, under `secret`. */
export function signAuth(
  raw: Uint8Array | string,
  at: number = ah.clock,
  id: string = randomUUID(),
  secret: string = AUTH_HOOK_SECRET,
): Signed {
  const key = Buffer.from(secret.slice('v1,whsec_'.length), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${id}.${String(at)}.`)
    .update(raw)
    .digest('base64');
  return { id, timestamp: String(at), signature: `v1,${mac}` };
}

/** POST to the route: signed under the given header names, the body as given. */
export async function postAuth(
  raw: Uint8Array | string,
  signed: Signed | null = signAuth(raw),
  names: readonly [string, string, string] = [
    'webhook-id',
    'webhook-timestamp',
    'webhook-signature',
  ],
  app: Hono = ah.app,
): Promise<{ readonly status: number; readonly text: string }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signed !== null) {
    headers.set(names[0], signed.id);
    headers.set(names[1], signed.timestamp);
    headers.set(names[2], signed.signature);
  }
  const response = await app.fetch(
    new Request(`http://api.test${AUTH_EMAIL_HOOK_PATH}`, {
      method: 'POST',
      headers,
      body: typeof raw === 'string' ? raw : new Uint8Array(raw),
    }),
  );
  return { status: response.status, text: await response.text() };
}

/** The asked observation's evidence for an invitation's attempts, oldest first. */
export async function attemptRows(
  invitationId: string,
): Promise<readonly { state: string; evidence: string | null }[]> {
  return await w.db.admin.execute<{ state: string; evidence: string | null }>(
    `select state, evidence from public.invitation_delivery_attempts
      where invitation_id = $1 order by observed_seq`,
    [invitationId],
  );
}

/** Every message the email provider received for one address. */
export const mailTo = (address: string): readonly string[] =>
  w.provider.received
    .map((message) => message.body)
    .filter((body) => body.includes(JSON.stringify(address)));
