// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's Send Email hook message (C39-T): what the provider
// asks to be mailed. Read only after its signature verified (`email-hook.ts`),
// strictly, and to two values: the action and the address. An invitation's
// link carries a token of our own (`broker-invitation.ts`), and the login
// provider is never asked for one.
//
// One exception (C40, ORCH60): a `recovery` message is also read for the
// user's id and the provider's hashed token, which the reset mail's link
// carries in its fragment: the provider issues and verifies reset links, and
// a reset can be built on nothing else. Every other action's tokens (its
// hashed token, its one-time code, an address change's new ones) are never
// read, and a recovery message's one-time code is not read either.

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

/** A provider user id: a UUID. */
const USER_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** The provider's hashed token: hex, bounded, nothing that could break out of a link. */
const TOKEN_HASH = /^[\da-f]{32,128}$/iu;

/** What a reset mail needs beyond the address (C40): the login, and its link's hashed token. */
export interface Recovery {
  readonly subject: string;
  readonly tokenHash: string;
}

/**
 * What a verified hook message asks for: the action and the address, and for
 * `recovery` alone the login and the hashed token its link carries.
 */
export interface AuthMessage {
  readonly action: string;
  readonly address: string;
  readonly recovery?: Recovery;
}

/** A recovery message's login and hashed token, or nothing when either is missing or malformed. */
function recoveryOf(
  user: Record<string, unknown>,
  data: Record<string, unknown>,
): Recovery | undefined {
  const { id } = user;
  const hash = data['token_hash'];
  if (typeof id !== 'string' || !USER_ID.test(id)) return undefined;
  if (typeof hash !== 'string' || !TOKEN_HASH.test(hash)) return undefined;
  return { subject: id.toLowerCase(), tokenHash: hash };
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
  if (!ADDRESS.test(address)) return undefined;
  if (action !== 'recovery') return { action, address };
  const recovery = recoveryOf(body['user'], body['email_data']);
  return recovery === undefined ? undefined : { action, address, recovery };
}
