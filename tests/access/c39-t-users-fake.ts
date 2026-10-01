// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the login provider's admin users route (C39-T, piece P3):
// answers `POST /auth/v1/admin/users` and `PUT /auth/v1/admin/users/<id>` on
// loopback the way Supabase Auth does. A POST makes a user under the id it
// names, or 422 `email_exists` for an address it already holds; a PUT sets
// one user's address and password, 404 `user_not_found` for an id it does
// not hold and 422 for an address another user holds; a GET reads one
// user, 404 for an id it does not hold. It keeps every
// request, the users it holds and each one's password, so a case can count
// what was asked and look for the password everywhere else. Its hostile
// modes are the answers a real provider can give: an answer echoing the
// password, oversized, redirected, malformed, a wrong id, another user's
// id, a fault and slow. As a real provider does, every mode but `fault`
// makes or sets the user before it answers; `fault` changes nothing. A case
// may plant a user made elsewhere, its address confirmed or not.

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
  | 'other_id'
  | 'fault'
  | 'slow'
  | 'made_late';

export interface UsersRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  /** The `apikey` header, kept only when one came (a hosted provider's secret key, C39-T). */
  readonly apikey?: string;
  readonly body: Record<string, unknown>;
}

export interface FakeUsers {
  readonly origin: string;
  readonly received: readonly UsersRequest[];
  /** The users it holds: address to id. */
  readonly users: ReadonlyMap<string, string>;
  /** Each user's password as last set: id to password. */
  readonly passwords: ReadonlyMap<string, string>;
  mode(next: FakeUsersMode): void;
  /** A user made elsewhere, under a new id, its address confirmed or not; its id. */
  plant(email: string, confirmed: boolean): string;
  /** Run `work` when the next request arrives, before it is answered. */
  beforeNext(work: () => Promise<void>): void;
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
const user = (id: string, email: string, confirmed = true): Record<string, unknown> => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: confirmed ? new Date().toISOString() : null,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
});

interface Kept {
  readonly users: Map<string, string>;
  readonly passwords: Map<string, string>;
  readonly timers: Set<NodeJS.Timeout>;
  /** The ids whose address the provider has not confirmed. */
  readonly unconfirmed: Set<string>;
  next?: (() => Promise<void>) | undefined;
}

interface Asked {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const EXISTS = { status: 422, answer: { code: 422, error_code: 'email_exists', msg: 'exists' } };
const NOT_FOUND = { status: 404, answer: { code: 404, error_code: 'user_not_found', msg: 'gone' } };
const UPDATE_PATH = /^\/auth\/v1\/admin\/users\/([\da-f-]{36})$/u;

/** What an honest provider does: the user made or set, or why not, and its answer. */
function honest(asked: Asked, kept: Kept): { status: number; answer: Record<string, unknown> } {
  if (asked.method === 'GET') {
    const wanted = UPDATE_PATH.exec(asked.path)?.[1];
    const [address] = [...kept.users].find(([, one]) => one === wanted) ?? [];
    if (wanted === undefined || address === undefined) return NOT_FOUND;
    return { status: 200, answer: user(wanted, address, !kept.unconfirmed.has(wanted)) };
  }
  const email = String(asked.body['email']);
  const holder = kept.users.get(email);
  const held = (id: string): boolean => [...kept.users.values()].includes(id);
  const update = asked.method === 'PUT';
  const id = update
    ? (UPDATE_PATH.exec(asked.path)?.[1] ?? '')
    : String(asked.body['id'] ?? randomUUID());
  if (update && !held(id)) return NOT_FOUND;
  // An address held by a user, another one on an update: nothing is made or set.
  if (holder !== undefined && (!update || holder !== id)) return EXISTS;
  if (!update && held(id)) {
    return { status: 500, answer: { code: 500, msg: 'Database error creating new user' } };
  }
  for (const [address, one] of kept.users) if (one === id) kept.users.delete(address);
  kept.users.set(email, id);
  kept.passwords.set(id, String(asked.body['password']));
  return { status: 200, answer: user(id, email) };
}

function respond(mode: FakeUsersMode, asked: Asked, response: ServerResponse, kept: Kept): void {
  const json = (status: number, answer: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  };
  if (mode === 'fault') return json(500, { code: 500, msg: 'unexpected failure' });
  const made = honest(asked, kept);
  if (mode === 'accept' || made.status !== 200) return json(made.status, made.answer);
  const { id, email } = made.answer as { id: string; email: string };
  switch (mode) {
    case 'echo':
      return json(200, { ...made.answer, password: asked.body['password'] });
    case 'oversized':
      return json(200, { ...made.answer, padding: 'x'.repeat(64 * 1024) });
    case 'redirect':
      response.writeHead(307, { location: 'http://203.0.113.9/auth/v1/admin/users' });
      response.end();
      return;
    case 'not_json':
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{"id":"${id}"`);
      return;
    case 'bad_id':
      return json(200, { ...made.answer, id: `${id}&next=x` });
    case 'other_id':
      return json(200, user(randomUUID(), email));
    case 'slow':
    case 'made_late': {
      // Made, as a real provider does before it answers; the answer comes after the timeout.
      const timer = setTimeout(() => {
        kept.timers.delete(timer);
        json(200, made.answer);
      }, 10_000);
      kept.timers.add(timer);
    }
  }
}

/** A user made elsewhere, under a new id, its address confirmed or not. */
function plant(kept: Kept, email: string, confirmed: boolean): string {
  const id = randomUUID();
  kept.users.set(email, id);
  if (!confirmed) kept.unconfirmed.add(id);
  return id;
}

/** Start the stand-in on a loopback port of its own. */
export async function startFakeUsers(): Promise<FakeUsers> {
  let current: FakeUsersMode = 'accept';
  const received: UsersRequest[] = [];
  const kept: Kept = {
    users: new Map(),
    passwords: new Map(),
    timers: new Set(),
    unconfirmed: new Set(),
  };
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const body = await readAll(request);
      const path = request.url ?? '';
      const method = request.method ?? '';
      const { authorization, apikey } = request.headers;
      const keyed = typeof apikey === 'string' ? { apikey } : {};
      received.push({ method, path, authorization, ...keyed, body });
      const work = kept.next;
      kept.next = undefined;
      await work?.();
      respond(current, { method, path, body }, response, kept);
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
    passwords: kept.passwords,
    mode: (next) => {
      current = next;
    },
    plant: (email, confirmed) => plant(kept, email, confirmed),
    beforeNext: (work) => {
      kept.next = work;
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
