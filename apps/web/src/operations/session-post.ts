// SPDX-License-Identifier: AGPL-3.0-only
//
// A POST to a route of the API that is not a business's but reads the
// signed-in session (`/api/b/enrol`, C39-T). The credential is the session
// cookie, which no script reads: the browser sends it on its own origin, and
// this adds what the API checks a cookie's request by, the own-page header
// and the sign-in this tab names. Nothing else goes: no business, no actor.

import { CSRF_HEADER, SESSION_HEADER } from '../../../../packages/core-wire/src/index.ts';

/** POST `body` to `route` with this tab's session; the answer's JSON, or a throw. */
export async function postWithSession(
  app: { readonly fetch: typeof globalThis.fetch; readonly apiOrigin: string },
  route: string,
  sessionId: string | undefined,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [CSRF_HEADER]: '1',
  };
  if (sessionId !== undefined) headers[SESSION_HEADER] = sessionId;
  const response = await app.fetch(`${app.apiOrigin}${route}`, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  return await response.json();
}
