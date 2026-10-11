// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in service as the worker meets it (`apps/worker/sign-in.ts`), for
// suites that are about something else. In process, `signedInReach` answers
// the password grant with a made-up or fixture token; for a worker run as its
// own process, `standInGoTrue` serves the same grant on a loopback port and
// counts each sign-in. With `key` set, a grant without that `apikey` is
// refused as hosted GoTrue refuses it.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpTransport } from '../../apps/cli/client.ts';
import type { Reach } from '../../apps/worker/main.ts';

/** The worker's login settings, made up: the stand-in takes any email and password. */
export const SIGN_IN_SETTINGS = {
  OPS_ASTRO_EMAIL: 'agent@example.test',
  OPS_ASTRO_PASSWORD: 'made-up-agent-password',
  OPS_ASTRO_GOTRUE_URL: 'http://127.0.0.1:54391',
} as const;

/** GoTrue's answer to a password grant. */
const granted = (token: string, expiresIn: number): Response =>
  Response.json({ access_token: token, token_type: 'bearer', expires_in: expiresIn });

/** The worker's real API transport, its sign-in answered with `token` in process. */
export const signedInReach = (token: string, expiresIn = 3_600): Reach => ({
  transport: httpTransport,
  signIn: () => Promise.resolve(granted(token, expiresIn)),
});

export interface StandIn {
  readonly url: string;
  /** How many password grants it has answered with a token. */
  readonly signIns: () => number;
  readonly close: () => Promise<void>;
}

/** GoTrue's password grant on a loopback port, each answer a token from `issue`. */
export async function standInGoTrue(options: {
  readonly issue: () => Promise<string>;
  readonly expiresIn: number;
  readonly key?: string;
}): Promise<StandIn> {
  let signIns = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      void (async () => {
        const keyed = options.key === undefined || request.headers['apikey'] === options.key;
        const grant = request.method === 'POST' && request.url === '/token?grant_type=password';
        let answer = new Response(null, { status: 404 });
        if (grant && keyed) answer = granted(await options.issue(), options.expiresIn);
        if (grant && !keyed) {
          answer = Response.json({ message: 'No API key found in request' }, { status: 401 });
        }
        if (grant && keyed) signIns += 1;
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(await answer.text());
      })();
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    signIns: () => signIns,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => {
        server.close(done);
      });
    },
  };
}
