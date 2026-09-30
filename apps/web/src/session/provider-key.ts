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
    const headers = new Headers(init?.headers);
    headers.set('apikey', key);
    return await fetcher(input, { ...init, headers });
  }) as typeof fetch;
}
