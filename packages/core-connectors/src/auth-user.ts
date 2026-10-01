// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's two catalogued operations (C39-T, piece P3), read the
// way every catalogued operation is (`operation.ts`): `auth.create_user`, a
// login made when an invitation is accepted, and `auth.update_user`, the same
// login set again when an earlier accept made it and never bound it.
//
// Each adapter takes the user's id, the invited address and the password the
// enrolment page set, and asks Supabase Auth's admin route for a user under
// that id whose address is confirmed: the address is the invitation's, and
// only its holder had the link. The id is ours, chosen by the caller, so a
// login the provider made behind an answer that never arrived is found again.
// Custody adds the origin and the service key, so the key never leaves
// custody's process. Of the answer only the user's id is read, the subject
// the product's `logins` row keeps; the password goes into the request and
// nowhere else.
//
// An address that already holds a login is answered 422 by the provider, and
// nothing is made or changed (`AUTH_EMAIL_EXISTS`); an update naming no user
// is answered 404, and nothing is changed (`AUTH_USER_NOT_FOUND`).

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

/** The admin route that makes a user without sending any mail. */
export const AUTH_USERS_PATH = '/auth/v1/admin/users';

/** The provider's code for an address that already holds a login: nothing was made. */
export const AUTH_EMAIL_EXISTS = 'email_exists';

/** The HTTP status the provider answers `email_exists` with. */
export const AUTH_EXISTS_STATUS = 422;

/** The provider's code for an update naming no user: nothing was changed. */
export const AUTH_USER_NOT_FOUND = 'user_not_found';

/** The HTTP status the provider answers `user_not_found` with. */
export const AUTH_NOT_FOUND_STATUS = 404;

/** A provider user id: a UUID, lower or upper case, nothing that could carry more. */
const USER_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** The id, the address and the password, each present, the id a UUID, or a throw. */
function userValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const { id, email, password } = values;
  if (id === undefined || email === undefined || password === undefined) {
    throw new Error('auth user adapter: a declared field is missing');
  }
  if (!USER_ID.test(id)) throw new Error('auth user adapter: the id is not a UUID');
  return { id: id.toLowerCase(), email, password };
}

/** The id, the address and the password in, a request with neither origin nor credential out. */
export function authUserAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { id, email, password } = userValues(values);
  return {
    path: AUTH_USERS_PATH,
    method: 'POST',
    body: JSON.stringify({ id, email, password, email_confirm: true }),
  };
}

/** The same in, the one user's update out: its id is the path's one segment. */
export function authUserUpdateAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { id, email, password } = userValues(values);
  return {
    path: `${AUTH_USERS_PATH}/${id}`,
    method: 'PUT',
    body: JSON.stringify({ email, password, email_confirm: true }),
  };
}

/** The answer schema: a user object whose `id` is a UUID, or the whole answer is malformed. */
export function readAuthUserAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const id = (body as Record<string, unknown>)['id'];
  if (typeof id !== 'string' || !USER_ID.test(id)) return undefined;
  return {
    text: id.toLowerCase(),
    model: null,
    usage: { inputUnits: 0, outputUnits: 0 },
    providerCode: null,
  };
}

/** One login for one address. Not billed, the smallest priced maximum. */
export const AUTH_CREATE_USER: ModelOperationDeclaration = {
  key: 'auth.create_user',
  provider: 'supabase_auth',
  destination: 'auth',
  fields: { id: 'personal', email: 'personal', password: 'personal' },
  answer: readAuthUserAnswer,
  timeoutMs: 10_000,
  maxResponseBytes: 16 * 1024,
  maximumMinor: 1,
  settlesAt: 'accepted',
  nothingHappened: [AUTH_EMAIL_EXISTS],
  billed: false,
  concurrency: 4,
};

/**
 * One login set again, under the id it was made with. Its own provider key,
 * so its adapter is its own; the route is the same login provider's.
 */
export const AUTH_UPDATE_USER: ModelOperationDeclaration = {
  ...AUTH_CREATE_USER,
  key: 'auth.update_user',
  provider: 'supabase_auth_update',
  nothingHappened: [AUTH_USER_NOT_FOUND, AUTH_EMAIL_EXISTS],
};
