// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C59 factor-route cases share (`c59-factor-routes.test.ts` and
// `c59-factor-routes-hostile.test.ts`): a stand-in sign-in provider on a
// loopback port, the real API calling it, and four clients of alpha. Each file
// opens its own, and keeps its own replies and record of requests.
//
// The provider is the one thing not real here, and it is stood in for at the
// network, not in code: `auth/factors.ts` makes its real calls over HTTP to a
// server this file controls, so every hostile answer (malformed, oversized,
// slow, the wrong shape, a redirect, a server error) reaches the adapter the
// way GoTrue's would. The shared local GoTrue is never reconfigured for this.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign } from 'hono/jwt';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { liveFactor } from '../../packages/core-records/src/identity/second-factor.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  ACCEPTANCE_ISSUER,
  ACCEPTANCE_SECRET,
  bearer,
  call,
  createWorld,
  personPath,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';

export const CANARY = 'CANARY-c59-totp-secret-7f3a9e';

export const now = (): number => Math.floor(Date.now() / 1000);

export const GOOD_TOTP: Readonly<Record<string, string>> = {
  qr_code: 'data:,x',
  secret: 'S',
  uri: 'otpauth://totp/x',
};
export const GOOD_ENROL: Readonly<Record<string, unknown>> = {
  id: 'factor-one',
  type: 'totp',
  totp: GOOD_TOTP,
};

/** What the stand-in provider does next, per path. */
export type Reply = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export const json =
  (status: number, value: unknown): Reply =>
  (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

export const GOOD: Readonly<Record<string, Reply>> = {
  'POST /factors': json(200, {
    id: 'factor-one',
    type: 'totp',
    totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: CANARY, uri: 'otpauth://totp/x' },
  }),
  'POST /factors/factor-one/challenge': json(200, { id: 'challenge-one', type: 'totp' }),
  'POST /factors/factor-one/verify': json(200, {
    access_token: 'aal2-access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
  }),
  'DELETE /factors/factor-one': json(200, { id: 'factor-one' }),
};

export interface Seen {
  readonly route: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** Hostile answers to an enrolment, each refused. */
export const HOSTILE: ReadonlyArray<readonly [string, Reply]> = [
  ['malformed JSON', (_q, response) => response.end('{"id": "factor-one", "totp": ')],
  // A good answer in every field but its size, so only the size limit refuses it.
  ['an oversized answer', json(200, { ...GOOD_ENROL, padding: 'x'.repeat(40_000) })],
  ['the wrong shape', json(200, { id: 'factor-one', totp: { secret: 42 } })],
  ['an id that is not an identifier', json(200, { id: '../admin', totp: GOOD_TOTP })],
  [
    'a redirect elsewhere',
    (_q, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    },
  ],
  ['a server error carrying the canary', json(500, { msg: `boom ${CANARY}` })],
];

export let world: World;
let provider: Server;
export let api: ReturnType<typeof createApi>;
export let slowApi: ReturnType<typeof createApi>;
export let clientA: Member;
export let clientB: Member;
/** A third client, whose factor the path and lockout cases use. */
export let clientC: Member;
/** A fourth client, who enrols from two tabs at once. */
export let clientD: Member;

/** A bearer carrying the assurance a sign-in gave it, signed as GoTrue signs. */
export const tokenFor = async (
  subject: string,
  assurance: {
    readonly aal: 'aal1' | 'aal2';
    readonly password: number;
    readonly totp?: number;
  },
): Promise<string> =>
  await sign(
    {
      sub: subject,
      aud: 'authenticated',
      iss: ACCEPTANCE_ISSUER,
      exp: now() + 600,
      aal: assurance.aal,
      amr: [
        { method: 'password', timestamp: assurance.password },
        ...(assurance.totp === undefined ? [] : [{ method: 'totp', timestamp: assurance.totp }]),
      ],
    },
    ACCEPTANCE_SECRET,
    'HS256',
  );

export const fresh = async (caller: { readonly subject: string } | Member): Promise<string> =>
  await tokenFor(subjectOf(caller), { aal: 'aal1', password: now() - 60 });

export const act = async (
  name: 'enrol' | 'verify' | 'remove',
  token: string,
  body: unknown = {},
  via?: ReturnType<typeof createApi>,
): Promise<Answer> =>
  await call(via ?? api, personPath('alpha', `/account/factor/${name}`), body, bearer(token));

export const factorOf = async (personId: string | null): ReturnType<typeof liveFactor> =>
  await world.db.app.withBusiness(world.alpha, async (tx) => await liveFactor(tx, personId ?? ''));

/** A row of the audit chain, as the cases compare it. */
export interface AuditOutcome {
  readonly outcome: string;
  readonly refusal_code: string | null;
}

export const eventsFor = async (command: string): Promise<readonly AuditOutcome[]> =>
  await world.db.app.withBusiness(world.alpha, (tx) =>
    tx.query<AuditOutcome>(
      `select outcome, refusal_code from public.audit_events
      where command = $1 order by seq`,
      [command],
    ),
  );

export const build = (
  timeoutMs?: number,
  basePath = '',
  database: Database = world.db.app,
): ReturnType<typeof createApi> =>
  createApi({
    database,
    verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET, issuer: ACCEPTANCE_ISSUER }),
    resolveBusiness: (key: string) =>
      Promise.resolve({ alpha: world.alpha, bravo: world.bravo }[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    factors: createGoTrueFactors({
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}${basePath}`,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  });

/** The test file's own replies and record of requests, read on every request. */
export interface Routes {
  replies(): Readonly<Record<string, Reply>>;
  saw(request: Seen): void;
}

/**
 * Opens a world named `name`, the stand-in provider on a loopback port
 * answering from `routes`, the API against it, and four clients of alpha.
 */
export async function openRoutes(name: string, routes: Routes): Promise<void> {
  world = await createWorld(name);
  provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const route = `${request.method} ${request.url}`;
      routes.saw({ route, authorization: request.headers.authorization, body });
      // The reply is chosen by comparing the request line with each known route, so the
      // request never names what is called (CodeQL js/unvalidated-dynamic-method-call).
      const reply =
        Object.entries(routes.replies()).find(([known]) => known === route)?.[1] ??
        json(404, { code: 404, msg: 'no such route' });
      reply(request, response, body);
    });
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, '127.0.0.1', resolve);
  });
  api = build();
  slowApi = build(200);

  // Two clients of alpha, each standing on one task shared with them.
  const tasks: string[] = [];
  for (const title of ['client A work', 'client B work']) {
    // oxlint-disable-next-line no-await-in-loop
    const created = await executeCommand(world.db.app, world.alpha, world.ada.presented, 'api', {
      command: 'task.create',
      operationId: `c59-${randomUUID()}`,
      fields: { title },
    });
    if (isCommandRefusal(created) || created.recordId === null) {
      throw new Error('task.create did not create the fixture task');
    }
    tasks.push(created.recordId);
  }
  const sharer = world.ada as unknown as Member;
  clientA = await shareWithClient(world.db.app, world.alpha, sharer, tasks[0] ?? '');
  clientB = await shareWithClient(world.db.app, world.alpha, sharer, tasks[1] ?? '');
  clientC = await shareWithClient(world.db.app, world.alpha, sharer, tasks[1] ?? '');
  clientD = await shareWithClient(world.db.app, world.alpha, sharer, tasks[0] ?? '');
}

export async function closeRoutes(): Promise<void> {
  await new Promise<void>((resolve) => {
    provider?.close(() => resolve());
  });
  await world?.close();
}

export function subjectOf(caller: { readonly subject: string } | Member): string {
  return 'subject' in caller ? caller.subject : caller.presented.subject;
}
