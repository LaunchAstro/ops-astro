// SPDX-License-Identifier: AGPL-3.0-only
//
// The hosted sign-in service refuses a request without the project's
// publishable key in an `apikey` header. The key is public and read at run
// time from `GET /api/sign-in` (one build serves every environment), and it is
// added here to calls under the sign-in address only, never to the API's.

/** `fetch`, adding the publishable key to every call under `issuer`; unchanged with no key. */
export function withProviderKey(
  fetcher: typeof fetch,
  issuer: string,
  key: string | undefined,
): typeof fetch {
  if (key === undefined || key === '') return fetcher;
  const base = `${issuer.replace(/\/$/u, '')}/`;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = input instanceof Request ? input.url : String(input);
    if (!address.startsWith(base)) return await fetcher(input, init);
    // A Request's own headers first, then the call's, then the key.
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    headers.set('apikey', key);
    // The key never follows a redirect to another host.
    return await fetcher(input, { ...init, headers, redirect: 'error' });
  }) as typeof fetch;
}
