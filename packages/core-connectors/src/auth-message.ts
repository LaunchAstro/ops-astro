// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's Send Email hook message (C39-T): what the provider
// asks to be mailed. Read only after its signature verified (`email-hook.ts`),
// strictly, and to two values: the action and the address. The provider's
// tokens (its hashed token, its one-time code) are never read: an
// invitation's link carries a token of our own (`broker-invitation.ts`), and
// the login provider is never asked for one.

/** An address as the invitation keeps it, at most the longest a mailbox may be. */
const ADDRESS = /^[^@\s]{1,64}@[^@\s]{1,189}$/u;

/** The actions the provider's hook may ask for. */
const AUTH_ACTIONS: ReadonlySet<string> = new Set([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'reauthentication',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a verified hook message asks for: the action and the address, nothing of its tokens. */
export interface AuthMessage {
  readonly action: string;
  readonly address: string;
}

/** The message from verified bytes: strict UTF-8, one JSON object, the provider's shape. */
export function readAuthMessage(raw: Uint8Array): AuthMessage | undefined {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return undefined;
  }
  if (!isObject(body) || !isObject(body['user']) || !isObject(body['email_data'])) {
    return undefined;
  }
  const email = body['user']['email'];
  const action = body['email_data']['email_action_type'];
  if (typeof action !== 'string' || !AUTH_ACTIONS.has(action)) return undefined;
  if (typeof email !== 'string') return undefined;
  const address = email.trim().toLowerCase();
  return ADDRESS.test(address) ? { action, address } : undefined;
}
