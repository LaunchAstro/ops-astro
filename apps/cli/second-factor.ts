// SPDX-License-Identifier: AGPL-3.0-only
//
// `login --second-factor`: the person's authenticator code, checked on their
// own account route (C59, `account/factor/verify`), the one the web's code
// step uses. The route asks the provider and answers the stepped-up token;
// the command line mints nothing and decides nothing. A sign-in the code did
// not finish is ended on the same person's account route
// (`account/sessions/sign-out`), as the web ends a code step that is left.

import { PREFIX } from '../../packages/core-wire/src/index.ts';
import type { Transport } from './client.ts';

export type StepUp =
  { readonly ok: true; readonly token: string } | { readonly ok: false; readonly because: string };

/** The person's account routes in `businessKey`, posted through the CLI's one transport (`client.ts`). */
interface Route {
  readonly businessKey: string;
  readonly transport: Transport;
}

async function post(route: Route, act: string, bearer: string, body: unknown): Promise<Response> {
  const path = `${PREFIX.person}${encodeURIComponent(route.businessKey)}/account/${act}`;
  return await route.transport(path, JSON.stringify(body), bearer);
}

/** What the answer says, by its refusal code or its status alone: never a value it carries. */
async function refusalOf(answer: Response): Promise<string> {
  const body = (await answer.json().catch(() => null)) as {
    refused?: unknown;
    code?: unknown;
  } | null;
  const code = body?.refused === true && typeof body.code === 'string' ? body.code : undefined;
  return code === undefined ? `the account route answered ${String(answer.status)}` : code;
}

/**
 * The stepped-up token for the sign-in `first` opened, or why not. On any
 * refusal, `first`'s sign-in is ended, as far as the route will, and nothing
 * of it is kept.
 */
export async function stepUp(route: Route, first: string, code: string): Promise<StepUp> {
  let because: string;
  try {
    const answer = await post(route, 'factor/verify', first, { code });
    const body = answer.ok
      ? ((await answer.json().catch(() => null)) as { accessToken?: unknown } | null)
      : null;
    const token = body?.accessToken;
    if (typeof token === 'string' && token !== '') return { ok: true, token };
    because = answer.ok ? 'the account route answered no token' : await refusalOf(answer);
  } catch {
    because = 'the account route could not be reached';
  }
  try {
    await post(route, 'sessions/sign-out', first, {});
  } catch {
    // Best effort: the half sign-in still ends at its own expiry.
  }
  return { ok: false, because };
}
