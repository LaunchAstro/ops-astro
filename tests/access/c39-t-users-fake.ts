// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the login provider's admin users route (C39-T, piece P3):
// answers `POST /auth/v1/admin/users` on loopback the way Supabase Auth
// does, a user object for a new address and 422 `email_exists` for one it
// already holds. It keeps every request and the users it made, so a case can
// count what was asked and look for the password everywhere else. Its
// hostile modes are the answers a real provider can give: an answer echoing
// the password, oversized, redirected, malformed, a wrong id, a fault and
// slow. Only `accept` makes a user.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeUsersMode =
  | 'accept'
  | 'echo'
  | 'oversized'
  | 'redirect'
  | 'not_json'
  | 'bad_id'
  | 'fault'
  | 'slow'
  | 'made_late';

export interface UsersRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface FakeUsers {
  readonly origin: string;
  readonly received: readonly UsersRequest[];
  /** The users it made: address to id. */
  readonly users: ReadonlyMap<string, string>;
  mode(next: FakeUsersMode): void;
  close(): Promise<void>;
}

async function readAll(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** GoTrue's user object, flat. */
const user = (id: string, email: string): Record<string, unknown> => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
});

interface Kept {
  readonly users: Map<string, string>;
  readonly timers: Set<NodeJS.Timeout>;
}

function respond(
  mode: FakeUsersMode,
  body: Record<string, unknown>,
  response: ServerResponse,
  kept: Kept,
): void {
  const json = (status: number, answer: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  };
  const email = String(body['email']);
  const id = randomUUID();
  switch (mode) {
    case 'accept': {
      if (kept.users.has(email)) {
        return json(422, { code: 422, error_code: 'email_exists', msg: 'already registered' });
      }
      kept.users.set(email, id);
      return json(200, user(id, email));
    }
    case 'echo':
      return json(200, { ...user(id, email), password: body['password'] });
    case 'oversized':
      return json(200, { ...user(id, email), padding: 'x'.repeat(64 * 1024) });
    case 'redirect':
      response.writeHead(307, { location: 'http://203.0.113.9/auth/v1/admin/users' });
      response.end();
      return;
    case 'not_json':
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{"id":"${id}"`);
      return;
    case 'bad_id':
      return json(200, { ...user(id, email), id: `${id}&next=x` });
    case 'fault':
      return json(500, { code: 500, msg: 'unexpected failure' });
    case 'made_late': {
      // The provider made the user, as a real one does before it answers;
      // the answer arrives after the caller's timeout.
      kept.users.set(email, id);
      const timer = setTimeout(() => {
        kept.timers.delete(timer);
        json(200, user(id, email));
      }, 10_000);
      kept.timers.add(timer);
      return;
    }
    case 'slow': {
      const timer = setTimeout(() => {
        kept.timers.delete(timer);
        json(200, user(id, email));
      }, 10_000);
      kept.timers.add(timer);
    }
  }
}

/** Start the stand-in on a loopback port of its own. */
export async function startFakeUsers(): Promise<FakeUsers> {
  let current: FakeUsersMode = 'accept';
  const received: UsersRequest[] = [];
  const kept: Kept = { users: new Map(), timers: new Set() };
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const body = await readAll(request);
      received.push({
        path: request.url ?? '',
        authorization: request.headers['authorization'],
        body,
      });
      respond(current, body, response, kept);
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received,
    users: kept.users,
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
