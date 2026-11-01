// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's own credential-carrying posts never follow a redirect. On a
// 307 or 308 fetch resends the method and body to the new location, so an API
// origin, or a proxy in front of one, that redirects to another origin would
// hand that origin the person's authenticator code or the provider's token. A
// redirect is an answer the page does not act on: the other origin receives
// nothing and the call does not succeed.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OperationsClient, isUnavailable } from '../../apps/web/src/operations/client.ts';
import { tradeForCookie } from '../../apps/web/src/session/sign-in.ts';

const CODE = '482913';
const TOKEN = 'provider-token-canary-7f2c90';
const received: string[] = [];
let elsewhere: Server;
let api: Server;
let origin = '';

const listening = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  elsewhere = createServer((request, response) => {
    received.push(
      `${request.method ?? ''} ${request.url ?? ''} ${JSON.stringify(request.headers)}`,
    );
    request.on('data', (chunk: Buffer) => received.push(chunk.toString()));
    request.on('end', () => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"accessToken":"aal2","session":"stolen","removed":true}');
    });
  });
  const other = await listening(elsewhere);
  api = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${other}/collect` }).end();
  });
  origin = `http://127.0.0.1:${await listening(api)}`;
});

afterAll(() => {
  api.close();
  elsewhere.close();
});

beforeEach(() => {
  received.length = 0;
});

const client = (): OperationsClient =>
  new OperationsClient({ origin, businessKey: 'alpha', signedIn: true, fetch: globalThis.fetch });

describe('a redirect to another origin receives no credential from the browser', () => {
  it('an authenticator code checked on the account sends nothing there and is not verified', async () => {
    const answer = await client().verifyFactor(CODE);
    expect(received).toEqual([]);
    expect(isUnavailable(answer)).toBe(true);
  });

  it('an authenticator removal sends nothing there and removes nothing', async () => {
    const answer = await client().removeFactor(CODE);
    expect(received).toEqual([]);
    expect(isUnavailable(answer)).toBe(true);
  });

  it('a provider token traded for the session cookie sends nothing there and is refused', async () => {
    const answer = await tradeForCookie({ apiOrigin: origin, fetch: globalThis.fetch }, TOKEN);
    expect(received).toEqual([]);
    expect(answer.ok).toBe(false);
  });
});
