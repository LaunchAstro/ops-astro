// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `c34-service-health.test.ts` opens: its stand-ins, callers and helpers, split from
// that file to keep it under the line limit. Its hooks are called at module
// level there, under the same skip as its cases.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createLangfuseHealth } from '../../apps/api/health/tracing.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type {
  HealthSource,
  HealthSources,
  ServiceObservation,
  SourceAnswer,
} from '../../packages/core-commands/src/index.ts';
import type {
  HealthSourceView,
  ServiceHealthSection,
  ServiceHealthView,
} from '../../packages/core-wire/src/index.ts';
import { ACCEPTANCE_ISSUER, ACCEPTANCE_SECRET, tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const CANARY = 'CANARY-c34-health-words-9e2c51';

export const ago = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

export const seen = (
  name: string,
  up: boolean | null,
  secondsAgo: number | null,
): ServiceObservation => ({
  name,
  scope: 'installation',
  up,
  observedAt: secondsAgo === null ? null : ago(secondsAgo),
});

/** A source at the port, counting the times it is asked. */
export class StandIn implements HealthSource {
  calls = 0;
  answer: () => Promise<SourceAnswer>;
  constructor(answer: () => Promise<SourceAnswer>) {
    this.answer = answer;
  }
  async observe(): Promise<SourceAnswer> {
    this.calls += 1;
    return await this.answer();
  }
}

export const answers =
  (...services: ServiceObservation[]): (() => Promise<SourceAnswer>) =>
  async () =>
    await Promise.resolve<SourceAnswer>({ ok: true, services });

export const statesOf = (section: ServiceHealthSection): Record<string, string> =>
  Object.fromEntries(section.services.map((row) => [`${row.source}:${row.name}`, row.state]));

export type Reply = (request: IncomingMessage, response: ServerResponse) => void;

export const json =
  (status: number, value: unknown): Reply =>
  (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

/** Each way a source can fail to be read, and the fault it is shown as. */
export const UNREADABLE: readonly [string, () => Promise<SourceAnswer>, string][] = [
  ['throws', async () => await Promise.reject(new Error(CANARY)), 'unreachable'],
  [
    'never answers',
    async () =>
      await new Promise<SourceAnswer>(() => {
        // Never settles: the time limit ends the read.
      }),
    'slow',
  ],
  ['a name that is empty', answers(seen('', true, 10)), 'malformed'],
  ['a name too long', answers(seen('x'.repeat(201), true, 10)), 'malformed'],
  [
    'a time that is no time',
    answers({ ...seen('api', true, 10), observedAt: new Date('x') }),
    'malformed',
  ],
  ['a time ahead of the clock', answers(seen('api', true, -3600)), 'malformed'],
  [
    'up that is no boolean',
    answers({ ...seen('api', true, 10), up: 'yes' as unknown as boolean }),
    'malformed',
  ],
  [
    'a fault it names',
    async () => await Promise.resolve<SourceAnswer>({ ok: false, fault: 'refused' }),
    'refused',
  ],
];

/** Each way a Langfuse answer can be wrong, and the fault it is shown as. */
export const HOSTILE_LANGFUSE: readonly [string, Reply, string][] = [
  [
    'a redirect to metadata',
    (_q, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    },
    'unreachable',
  ],
  ['an oversized answer', json(200, { status: 'OK', pad: 'x'.repeat(64 * 1024) }), 'oversized'],
  [
    'not JSON',
    (_q, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`<html>${CANARY}</html>`);
    },
    'malformed',
  ],
  ['OK with no status', json(200, { version: '3.0.0' }), 'malformed'],
  ['a 200 whose status is not OK', json(200, { status: 'starting' }), 'malformed'],
  ['a status that is no word', json(200, { status: { ok: true } }), 'malformed'],
  ['a refusal naming the canary', json(401, { message: CANARY }), 'refused'],
  ['a failure that is not shaped', json(500, { message: CANARY }), 'malformed'],
  [
    'no answer in time',
    () => {
      // Never answers: the adapter's time limit ends the call.
    },
    'slow',
  ],
];

export interface Heard {
  readonly route: string;
  readonly authorization: string | undefined;
}

export let harness: Harness;
export let credential: string;
export let clientToken: string;
let langfuse: Server;
let langfuseReply: Reply = json(200, { status: 'OK', version: '3.0.0' });

/** What the stand-in Langfuse answers next; `resetStandIns` puts back its healthy answer. */
export function replyAsLangfuse(next: Reply): void {
  langfuseReply = next;
}
export let heard: Heard[] = [];
export const watcher: StandIn = new StandIn(answers());
export const errorSink: StandIn = new StandIn(answers());

export type Api = ReturnType<typeof createApi>;

export const apiWith = (health?: HealthSources): Api =>
  createApi({
    database: harness.world.db.app,
    verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET, issuer: ACCEPTANCE_ISSUER }),
    resolveBusiness: async (key: string) =>
      await Promise.resolve({ alpha: harness.world.alpha, bravo: harness.world.bravo }[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    ...(health === undefined ? {} : { health }),
  });

export const tracing = (timeoutMs = 300): ReturnType<typeof createLangfuseHealth> =>
  createLangfuseHealth({
    baseUrl: `http://127.0.0.1:${(langfuse.address() as AddressInfo).port}/langfuse`,
    timeoutMs,
  });

export const view = async (
  api: ReturnType<typeof createApi>,
  token?: string,
  businessKey = 'alpha',
): Promise<Answer> =>
  await call(
    api,
    personPath(businessKey, '/operations/read'),
    { operationId: `c34-${randomUUID()}` },
    bearer(token ?? harness.world.ada.token),
  );

export const healthOf = async (
  api: Api,
  token?: string,
  key?: string,
): Promise<ServiceHealthSection> => {
  const answer = await view(api, token, key);
  expect(answer.status).toBe(200);
  return answer.body['serviceHealth'] as ServiceHealthSection;
};

export const tracingOf = async (
  api: Api,
): Promise<{
  readonly source: HealthSourceView | undefined;
  readonly states: readonly ServiceHealthView['state'][];
}> => {
  const section = await healthOf(api);
  return {
    source: section.sources.find((row) => row.source === 'tracing'),
    states: section.services.filter((row) => row.source === 'tracing').map((row) => row.state),
  };
};

export async function openHealthWorld(): Promise<void> {
  harness = await createHarness('c34_health');
  const { world } = harness;
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    await grantTo(tx, world.bea as unknown as Member, 'read', WHOLE_BUSINESS, false, 'operations');
  });
  const client = await shareWithClient(
    world.db.app,
    world.alpha,
    world.ada as unknown as Member,
    harness.alphaTask.id,
  );
  clientToken = await tokenFor(client.presented.subject);
  const { decided } = await harness.approvedReservation();
  expect(decided.code, 'the decision a pickup needs').toBe('ok');
  const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
  const picked = await harness.asAgent('task.pickup', { reservationId });
  expect(picked.code, 'the pickup').toBe('ok');
  credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);

  langfuse = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      heard.push({
        route: `${request.method} ${request.url}`,
        authorization: request.headers.authorization,
      });
      langfuseReply(request, response);
    });
  });
  await new Promise<void>((resolve) => {
    langfuse.listen(0, '127.0.0.1', resolve);
  });
}

export function resetStandIns(): void {
  langfuseReply = json(200, { status: 'OK', version: '3.0.0' });
  heard = [];
  watcher.answer = answers();
  errorSink.answer = answers();
}

export async function closeHealthWorld(): Promise<void> {
  langfuse?.closeAllConnections();
  await new Promise<void>((resolve) => {
    langfuse?.close(() => resolve());
  });
  await harness?.close();
}

/** The hooks a test file opening this world calls at module level, under its cases' skip. */
export function useHealthWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    await openHealthWorld();
  }, 120_000);
  afterEach(() => {
    if (serverUrl === undefined) return;
    resetStandIns();
  });
  afterAll(async () => {
    if (serverUrl === undefined) return;
    await closeHealthWorld();
  });
}
