// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the global `fetch` behind the command line's hosted presets:
// the two app origins, each one's sign-in address at `/api/sign-in`, each
// issuer's password grant, and every API call, all answered in-process.
//
// It handles a redirect the way fetch does. A request that does not say
// `redirect: 'manual'` has a 3xx answer followed to its `Location`, and that
// second request is recorded like any other, so a test can see whether
// anything reached the second origin. A latch can hold one answer back.

import { main as cli } from '../../apps/cli/main.ts';

export const SANDBOX = 'https://app.opsastro.com';
export const PRODUCTION = 'https://ops.agencyastro.com';

export const ISSUER: Readonly<Record<string, string>> = {
  [SANDBOX]: 'https://sandbox-issuer.example.test/auth/v1',
  [PRODUCTION]: 'https://production-issuer.example.test/auth/v1',
};
export const KEY: Readonly<Record<string, string>> = {
  [SANDBOX]: 'sb_publishable_sandbox-test-only',
  [PRODUCTION]: 'sb_publishable_production-test-only',
};

export interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: string | undefined;
}

export type Route = (url: URL, seen: Seen) => Response | undefined | Promise<Response | undefined>;

/** Tokens the grants hand out: a different one for each issuer and each grant. */
let issued = 0;
export function nextToken(issuer: string): string {
  issued += 1;
  return `${new URL(issuer).hostname.split('.')[0] ?? ''}-bearer-${String(issued)}`;
}

/** What the hosted app answers, unless `route` answers first. */
function standard(url: URL, seen: Seen): Response {
  for (const origin of [SANDBOX, PRODUCTION] as const) {
    if (url.origin === origin && url.pathname === '/api/sign-in') {
      return Response.json({ issuer: ISSUER[origin], key: KEY[origin] });
    }
    const issuer = ISSUER[origin] ?? '';
    if (url.href.startsWith(`${issuer}/token`)) {
      if (seen.headers['apikey'] !== KEY[origin]) {
        return Response.json({ message: 'No API key found in request' }, { status: 401 });
      }
      return Response.json({ access_token: nextToken(issuer), expires_in: 3600 });
    }
    if (url.origin === origin && url.pathname.startsWith('/api/')) {
      return Response.json({ ok: true, page: [], persons: [] });
    }
  }
  return new Response('not here', { status: 404 });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

export function standIn(route?: Route): {
  readonly fetch: typeof globalThis.fetch;
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
  const answer = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const one: Seen = {
      url: url.href,
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
    };
    seen.push(one);
    const response = (await route?.(url, one)) ?? standard(url, one);
    const location = response.headers.get('location');
    const redirected = response.status >= 300 && response.status < 400 && location !== null;
    if (redirected && init?.redirect !== 'manual')
      return await answer(new URL(location, url), init);
    return response;
  };
  const fetch: typeof globalThis.fetch = async (input, init) =>
    await answer(new URL(input instanceof Request ? input.url : String(input)), init);
  return { fetch, seen };
}

/** A promise the test opens when it chooses. */
export function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open?.() };
}

/** One in-process run of the command line, with what it printed. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cli(argv, env, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: async () => await Promise.resolve(''),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
