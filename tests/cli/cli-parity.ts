// SPDX-License-Identifier: AGPL-3.0-only
//
// One command sent through the CLI client (`apps/cli/client.ts`) and straight
// to the API, as the same caller with the same body, and the three ways a pair
// of answers may be alike: the same refusal with a named code, the same refusal
// word for word, or the same record apart from the values minted per call.
// The per-command CLI suites (API-2's, U14's) share it.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createCli, isWrite, type CliAnswer } from '../../apps/cli/client.ts';
import type { createApi } from '../../apps/api/app.ts';
import { agentPath, bearer, call, personPath } from '../acceptance/world.ts';

type Api = ReturnType<typeof createApi>;

export interface Pair {
  readonly cli: CliAnswer;
  readonly api: { readonly status: number; readonly body: Record<string, unknown> };
}

export interface Route {
  readonly businessKey?: string;
  readonly entry?: 'person' | 'agent';
}

/** The CLI client, posting into the served app in process. */
export const cliAs = (
  api: Api,
  token: string,
  businessKey: string,
  entry: 'person' | 'agent',
): ReturnType<typeof createCli> =>
  createCli({
    businessKey,
    credential: token,
    entry,
    transport: async (path, sent, credential) =>
      await api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...bearer(credential) },
          body: sent,
        }),
      ),
  });

/** One body through the CLI and another to the API, as the same caller; a write under its own operation each. */
export async function oneEach(
  api: Api,
  verb: string,
  bodies: {
    readonly cli: Readonly<Record<string, unknown>>;
    readonly api: Readonly<Record<string, unknown>>;
  },
  token: string,
  route: Route = {},
): Promise<Pair> {
  const businessKey = route.businessKey ?? 'alpha';
  const entry = route.entry ?? 'person';
  const operation = (surface: string) =>
    isWrite(verb) ? { operationId: `${surface}-${randomUUID()}` } : {};
  const heard = await cliAs(api, token, businessKey, entry).run(verb, {
    ...bodies.cli,
    ...operation('cli'),
  });
  const path = `/${verb.replace('.', '/')}`;
  const answer = await call(
    api,
    entry === 'agent' ? agentPath(businessKey, path) : personPath(businessKey, path),
    { ...bodies.api, ...operation('api') },
    bearer(token),
  );
  return { cli: heard, api: { status: answer.status, body: answer.body } };
}

/** The same body sent once through the CLI and once to the API. */
export const both = async (
  api: Api,
  verb: string,
  body: Readonly<Record<string, unknown>>,
  token: string,
  route: Route = {},
): Promise<Pair> => await oneEach(api, verb, { cli: body, api: body }, token, route);

/** A refusal is the same answer word for word on both. */
export function refusedAlike(pair: Pair, status: number, code: string): void {
  expect(pair.cli.status).toBe(status);
  expect(pair.api.status).toBe(status);
  expect((pair.cli.body as Record<string, unknown>)['code']).toBe(code);
  expect(pair.cli.body).toStrictEqual(pair.api.body);
}

/** Refused on both, with one answer; the code is whichever the API gives. */
export function refusedSame(pair: Pair): void {
  expect(pair.cli.status).toBeGreaterThanOrEqual(400);
  expect(pair.cli.body).toStrictEqual(pair.api.body);
}

/** The same answer on both, whatever it is, bar the values minted per call (named in `minted`). */
export function alike(pair: Pair, minted: ReadonlySet<string>): void {
  expect(pair.cli.status).toBe(pair.api.status);
  const shape = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body, (key, value: unknown) => (minted.has(key) ? typeof value : value)),
    );
  expect(shape(pair.cli.body)).toStrictEqual(shape(pair.api.body));
}

/** A success is the same record on both, bar the values minted per call. */
export function sameRecord(pair: Pair, minted: ReadonlySet<string>): void {
  expect(pair.cli.status).toBe(200);
  alike(pair, minted);
}
