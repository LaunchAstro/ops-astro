// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's one catalogued operation (C39-T, piece P3):
// `auth.create_user`, a login made when an invitation is accepted, read the
// way every catalogued operation is (`operation.ts`).
//
// The adapter takes the invited address and the password the enrolment page
// set, and asks Supabase Auth's admin route for a user whose address is
// confirmed: the address is the invitation's, and only its holder had the
// link. Custody adds the origin and the service key, so the key never leaves
// custody's process. Of the answer only the new user's id is read, the
// subject the product's `logins` row keeps; the password goes into the
// request and nowhere else.
//
// An address that already holds a login is answered 422 by the provider,
// and nothing is made (`AUTH_EMAIL_EXISTS`).

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

/** The admin route that makes a user without sending any mail. */
export const AUTH_USERS_PATH = '/auth/v1/admin/users';

/** The provider's code for an address that already holds a login: nothing was made. */
export const AUTH_EMAIL_EXISTS = 'email_exists';

/** The HTTP status the provider answers `email_exists` with. */
export const AUTH_EXISTS_STATUS = 422;

/** A provider user id: a UUID, lower or upper case, nothing that could carry more. */
const USER_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** The address and the password in, a request with neither origin nor credential out. */
export function authUserAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { email, password } = values;
  if (email === undefined || password === undefined) {
    throw new Error('auth user adapter: a declared field is missing');
  }
  return {
    path: AUTH_USERS_PATH,
    method: 'POST',
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
  fields: { email: 'personal', password: 'personal' },
  answer: readAuthUserAnswer,
  timeoutMs: 10_000,
  maxResponseBytes: 16 * 1024,
  maximumMinor: 1,
  settlesAt: 'accepted',
  nothingHappened: [AUTH_EMAIL_EXISTS],
  billed: false,
  concurrency: 4,
};
