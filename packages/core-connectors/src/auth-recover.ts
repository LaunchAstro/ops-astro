// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's third catalogued operation (C40, ORCH60):
// `auth.recover`, a password reset asked for one address. Supabase Auth's
// `POST /auth/v1/recover` mints its own single-use, short-lived reset token
// and, with the Send Email hook on, sends no mail of its own: it asks the
// hook (`auth-email-hook.ts`), which mails the link through the broker. For an
// address that holds no login it does nothing and answers the same.
//
// Custody adds the origin and the service key and lets the `auth`
// destination take this one POST path. The adapter sends the address alone;
// of the answer only that it is a JSON object is read, and nothing is kept.

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';
import { AUTH_CREATE_USER } from './auth-user.ts';

/** The provider's route that starts a reset by email. */
export const AUTH_RECOVER_PATH = '/auth/v1/recover';

/** The address in, the reset's request out: no origin, no credential, no link. */
export function authRecoverAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { email } = values;
  if (email === undefined) throw new Error('auth recover adapter: a declared field is missing');
  return { path: AUTH_RECOVER_PATH, method: 'POST', body: JSON.stringify({ email }) };
}

/** The answer schema: a JSON object, whatever it holds, read to nothing. */
export function readAuthRecoverAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return { text: '', model: null, usage: { inputUnits: 0, outputUnits: 0 }, providerCode: null };
}

/** One reset asked for one address. Not billed; its own provider key, so its own adapter. */
export const AUTH_RECOVER: ModelOperationDeclaration = {
  ...AUTH_CREATE_USER,
  key: 'auth.recover',
  provider: 'supabase_auth_recover',
  fields: { email: 'personal' },
  answer: readAuthRecoverAnswer,
  nothingHappened: [],
};
