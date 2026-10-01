// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's two edges (C39-T, piece P2), read the way every
// catalogued operation is (`operation.ts`).
//
// 1. `auth.invite_link`: the invitation's link, generated server-side by
//    Supabase Auth's admin route. The adapter takes the address alone and
//    asks for an invite link; custody adds the origin and the service key,
//    so the key never leaves custody's process. Of the answer only the
//    hashed token is read, in the provider's shape, and only when the link
//    is an invite: the one-time code, the action link and the user beside it
//    are never kept, returned or logged. The token goes into the enrolment
//    link the broker's `email.send` carries, and is kept as its SHA-256.
// 2. The Send Email hook's message: what the provider asks to be mailed.
//    Read only after its signature verified (`email-hook.ts`), strictly, and
//    to three values: the action, the address and the token hash.

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

/** The admin route that makes a link without sending any mail. */
export const AUTH_LINK_PATH = '/auth/v1/admin/generate_link';

/** The provider's code for an address that already holds a login: nothing was made. */
export const AUTH_EMAIL_EXISTS = 'email_exists';

/** The provider's token hash: hex SHA-224, 56 characters. Nothing else is a token here. */
const TOKEN_HASH = /^[0-9a-f]{56}$/u;

/** An address as the invitation keeps it, at most the longest a mailbox may be. */
const ADDRESS = /^[^@\s]{1,64}@[^@\s]{1,189}$/u;

/** The actions the provider's hook may ask for. */
export const AUTH_ACTIONS: ReadonlySet<string> = new Set([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'reauthentication',
]);

/** The address in, a request with neither origin nor credential out. */
export function authLinkAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { email } = values;
  if (email === undefined) throw new Error('auth link adapter: a declared field is missing');
  return { path: AUTH_LINK_PATH, method: 'POST', body: JSON.stringify({ type: 'invite', email }) };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The answer schema: an invite link's hashed token, or the whole answer is malformed. */
export function readAuthLinkAnswer(body: unknown): ModelAnswer | undefined {
  if (!isObject(body)) return undefined;
  const { hashed_token: token, verification_type: type } = body;
  if (type !== 'invite' || typeof token !== 'string' || !TOKEN_HASH.test(token)) return undefined;
  return { text: token, model: null, usage: { inputUnits: 0, outputUnits: 0 }, providerCode: null };
}

/**
 * One invite link for one address. Not billed, the smallest priced maximum.
 * An address that already holds a login is positive proof nothing was made.
 */
export const AUTH_INVITE_LINK: ModelOperationDeclaration = {
  key: 'auth.invite_link',
  provider: 'supabase_auth',
  destination: 'auth',
  fields: { email: 'personal' },
  answer: readAuthLinkAnswer,
  timeoutMs: 10_000,
  maxResponseBytes: 16 * 1024,
  maximumMinor: 1,
  settlesAt: 'accepted',
  nothingHappened: [AUTH_EMAIL_EXISTS],
  billed: false,
  concurrency: 4,
};

/** What a verified hook message asks for. An invitation's token hash goes only into a link. */
export interface AuthMessage {
  readonly action: string;
  readonly address: string;
  readonly tokenHash: string;
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
  const { email_action_type: action, token_hash: tokenHash } = body['email_data'];
  if (typeof action !== 'string' || !AUTH_ACTIONS.has(action)) return undefined;
  if (typeof email !== 'string' || typeof tokenHash !== 'string') return undefined;
  const address = email.trim().toLowerCase();
  if (!ADDRESS.test(address)) return undefined;
  // Only an invitation's token is ever used, and only its shape is checked.
  if (action !== 'invite') return { action, address, tokenHash: '' };
  return TOKEN_HASH.test(tokenHash) ? { action, address, tokenHash } : undefined;
}
