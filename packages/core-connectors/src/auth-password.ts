// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's catalogued password update (C40, ORCH77-C40B):
// `auth.update_user_password`, a reset's new password set on the one login
// its token names, read the way every catalogued operation is
// (`operation.ts`).
//
// The adapter takes the login's provider id and the new password, and asks
// Supabase Auth's admin route to set that user's password and nothing else.
// Custody adds the origin and the service key, so the key never leaves
// custody's process, and sends the PUT only to the route its destination
// lists. Of the answer only the user's id is read; the password goes into the
// request and nowhere else. A 422 is the provider's no to the password itself
// (weak, leaked or the same as before), and nothing is changed.

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

/** The admin route that sets one user: its id is the path's last segment. */
export const AUTH_USERS_PATH = '/auth/v1/admin/users';

/** The HTTP status the provider refuses a password with. */
export const PASSWORD_REFUSED_STATUS = 422;

/** A provider user id (GoTrue's is a UUID): one path segment custody's `/*` admits, no more. */
const USER_ID = /^[\w-]{1,128}$/u;

/** The id and the new password in, one user's update out, with neither origin nor credential. */
export function authPasswordAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { id, password } = values;
  if (id === undefined || password === undefined || !USER_ID.test(id)) {
    throw new Error('auth password adapter: a declared field is missing or malformed');
  }
  return {
    path: `${AUTH_USERS_PATH}/${id}`,
    method: 'PUT',
    body: JSON.stringify({ password }),
  };
}

/** The answer schema: a user object whose `id` is a UUID, or the whole answer is malformed. */
export function readAuthPasswordAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const id = (body as Record<string, unknown>)['id'];
  if (typeof id !== 'string' || !USER_ID.test(id)) return undefined;
  return {
    text: id,
    model: null,
    usage: { inputUnits: 0, outputUnits: 0 },
    providerCode: null,
  };
}

/** One login's new password. Not billed, the smallest priced maximum. */
export const AUTH_UPDATE_USER_PASSWORD: ModelOperationDeclaration = {
  key: 'auth.update_user_password',
  provider: 'supabase_auth_password',
  destination: 'auth',
  fields: { id: 'personal', password: 'personal' },
  answer: readAuthPasswordAnswer,
  timeoutMs: 10_000,
  maxResponseBytes: 16 * 1024,
  maximumMinor: 1,
  settlesAt: 'accepted',
  nothingHappened: ['weak_password', 'same_password'],
  billed: false,
  concurrency: 4,
};
