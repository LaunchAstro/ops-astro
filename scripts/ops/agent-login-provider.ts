// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's calls to the provider's admin API (agent-login.ts).
// One destination, GOTRUE_URL; no redirect followed; a time limit and a size
// limit read off the stream; the provider's own words never printed. A user
// is accepted only when its marker names this act, so a rerun finds the user
// its first run made and never sets its password again.

import { isTimeout, readBounded } from '../../apps/api/auth/factors.ts';
import type { Act, Run } from './agent-login-acting.ts';
import { listedId, Refusal } from './staging-reset.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;

async function call(
  run: Run,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body?: unknown }> {
  const base = new URL(run.env['GOTRUE_URL'] ?? '');
  const url = new URL(`${base.pathname.replace(/\/+$/u, '')}${path}`, base);
  const key = run.env['SUPABASE_SERVICE_KEY'] ?? '';
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new Refusal(`the provider did not answer (${isTimeout(cause) ? 'slow' : 'unreachable'})`);
  }
  const read = await readBounded(response, MAX_BYTES, TIMEOUT_MS);
  if ('fault' in read) throw new Refusal(`the provider's answer was refused (${read.fault})`);
  try {
    return { status: response.status, body: JSON.parse(read.text) as unknown };
  } catch {
    return { status: response.status };
  }
}

/** This act's provider user: made now with this act's marker, or found by its address bearing it. */
export async function providerUser(run: Run, act: Act, password: string): Promise<string> {
  const app_metadata = { ops_astro_login_act: act.id };
  const asked = { email: act.email, password, email_confirm: true, app_metadata };
  const made = await call(run, 'POST', '/admin/users', asked);
  let user = made.status === 200 || made.status === 201 ? made.body : undefined;
  if (user === undefined) {
    if (made.status !== 422) throw new Refusal(`the provider refused the user (${made.status})`);
    const id = await listedId(async (path, method) => await call(run, method, path), act.email);
    if (typeof id !== 'string' || !UUID.test(id))
      throw new Refusal('the provider holds the address but lists no user for it');
    user = (await call(run, 'GET', `/admin/users/${id}`)).body;
  }
  const {
    id,
    email,
    app_metadata: marker,
  } = (user ?? {}) as {
    id?: unknown;
    email?: unknown;
    app_metadata?: { ops_astro_login_act?: unknown };
  };
  if (typeof id !== 'string' || !UUID.test(id) || email !== act.email)
    throw new Refusal("the provider's answer named no user for this address");
  if (marker?.ops_astro_login_act !== act.id)
    throw new Refusal("the provider's user for this address was not made by this act: refused");
  return id;
}
