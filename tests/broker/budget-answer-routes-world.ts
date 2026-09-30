// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at parity, the shared half: the real API boundary over the
// broker world, a second business on the same installation whose decider
// holds both answers' grants in their own business, and the bodies and reads
// the route suites compare. A harness, not a suite.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { beforeAll } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
} from '../../packages/core-commands/src/index.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { seedSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { noDatabase, s } from './broker-world.ts';
import { one } from './budget-answers-world.ts';

export interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export let api: Hono;
export let alphaKey: string;
export let bravo: Schedules;
export let bravoKey: string;

const keyOf = async (business: string): Promise<string> =>
  (await one<{ key: string }>('select key from public.businesses where id = $1', [business])).key;

/** Mounts the boundary and seeds bravo, once per file, after the broker world opens. */
export function useAnswerRoutes(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    api = createApi({
      database: s.db.app,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: createBusinessResolver(s.db.admin),
      executeRead,
      executeCommand,
      executeAgentCommand,
    });
    alphaKey = await keyOf(s.business);
    bravo = await seedSchedules(s.db, `${part}b`, 1_000_000);
    bravoKey = await keyOf(bravo.business);
    await bravo.db.app.withBusiness(bravo.business, async (tx) => {
      await grantTo(tx, bravo.decider, 'decide', undefined, false, 'billing');
      await grantTo(tx, bravo.decider, 'decide', undefined, false, 'gate');
    });
  }, 180_000);
}

export const post = async (
  prefix: string,
  path: string,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>>,
): Promise<Answer> => {
  const response = await api.fetch(
    new Request(`http://api.test/api/${prefix}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Answer['body'] };
};

export const asPerson = async (
  member: Member,
  path: string,
  body: Readonly<Record<string, unknown>>,
  key: string = alphaKey,
): Promise<Answer> =>
  await post(`b/${key}`, path, body, {
    authorization: `Bearer ${await tokenFor(member.presented.subject)}`,
  });

export const topUpBody = (taskId: string, runId: string): Record<string, unknown> => ({
  operationId: randomUUID(),
  recordId: taskId,
  runId,
  amountMinor: 1_000,
  currency: 'AUD',
});

export const endBody = (taskId: string, runId: string): Record<string, unknown> => ({
  operationId: randomUUID(),
  recordId: taskId,
  runId,
});

export const revisionOf = async (taskId: string): Promise<string> =>
  (
    await one<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    )
  ).revision;

/** A refusal's bytes, less the one field that is the caller's own. */
export const bytesOf = (answer: Answer): string => {
  const { operationId: _own, ...rest } = answer.body;
  return JSON.stringify({ status: answer.status, ...rest });
};
