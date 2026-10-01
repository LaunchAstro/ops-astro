// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the login provider's admin route (C39-T, piece P2): answers
// `POST /auth/v1/admin/generate_link` on loopback the way Supabase Auth does,
// a flat user object with the link's properties beside it. Each accepted
// answer carries a fresh hashed token and a planted one-time code, both kept
// here so a case can look for them everywhere else. Its hostile modes are
// the answers a real provider can give: refused, oversized, redirected,
// malformed and slow.

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeAuthMode =
  | 'accept'
  | 'exists'
  | 'oversized'
  | 'redirect'
  | 'not_json'
  | 'bad_token'
  | 'other_type'
  | 'no_token'
  | 'slow';

export interface AuthRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface FakeAuth {
  readonly origin: string;
  readonly received: readonly AuthRequest[];
  /** Every hashed token and one-time code it answered with. */
  readonly issued: readonly { readonly hashed: string; readonly otp: string }[];
  mode(next: FakeAuthMode): void;
  close(): Promise<void>;
}

async function readAll(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

/** GoTrue's answer: the user, then the link's properties, flat. */
function answer(email: string, hashed: string, otp: string, type = 'invite'): object {
  return {
    id: randomUUID(),
    aud: 'authenticated',
    role: 'authenticated',
    email,
    invited_at: new Date().toISOString(),
    app_metadata: { provider: 'email' },
    user_metadata: {},
    action_link: `https://auth.example.test/auth/v1/verify?token=${hashed}&type=${type}`,
    email_otp: otp,
    hashed_token: hashed,
    verification_type: type,
    redirect_to: 'https://ops.example.test',
  };
}

function respond(
  mode: FakeAuthMode,
  email: string,
  response: ServerResponse,
  kept: { issued: { hashed: string; otp: string }[]; timers: Set<NodeJS.Timeout> },
): void {
  const json = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const hashed = randomBytes(28).toString('hex');
  const otp = `otp${randomBytes(6).toString('hex')}`;
  kept.issued.push({ hashed, otp });
  switch (mode) {
    case 'accept':
      return json(200, answer(email, hashed, otp));
    case 'exists':
      return json(422, { code: 422, error_code: 'email_exists', msg: 'already registered' });
    case 'oversized':
      return json(200, { ...answer(email, hashed, otp), padding: 'x'.repeat(64 * 1024) });
    case 'redirect':
      response.writeHead(307, { location: 'http://203.0.113.9/auth/v1/admin/generate_link' });
      response.end();
      return;
    case 'not_json':
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{"hashed_token":"${hashed}"`);
      return;
    case 'bad_token':
      return json(200, { ...answer(email, hashed, otp), hashed_token: `${hashed}&next=x` });
    case 'other_type':
      return json(200, answer(email, hashed, otp, 'magiclink'));
    case 'no_token': {
      const { hashed_token: _dropped, ...rest } = answer(email, hashed, otp) as Record<
        string,
        unknown
      >;
      return json(200, rest);
    }
    case 'slow': {
      const timer = setTimeout(() => {
        kept.timers.delete(timer);
        json(200, answer(email, hashed, otp));
      }, 10_000);
      kept.timers.add(timer);
    }
  }
}

/** Start the stand-in on a loopback port of its own. */
export async function startFakeAuth(): Promise<FakeAuth> {
  let current: FakeAuthMode = 'accept';
  const received: AuthRequest[] = [];
  const kept = {
    issued: [] as { hashed: string; otp: string }[],
    timers: new Set<NodeJS.Timeout>(),
  };
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const body = await readAll(request);
      received.push({
        path: request.url ?? '',
        authorization: request.headers['authorization'],
        body,
      });
      let email = '';
      try {
        email = String((JSON.parse(body) as Record<string, unknown>)['email']);
      } catch {
        email = '';
      }
      respond(current, email, response, kept);
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received,
    issued: kept.issued,
    mode: (next) => {
      current = next;
    },
    close: async () => {
      for (const timer of kept.timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
