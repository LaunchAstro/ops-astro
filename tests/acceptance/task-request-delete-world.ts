// SPDX-License-Identifier: AGPL-3.0-only
//
// What #2351's two test files share: a harness with Ada's agent credential
// (task read, write and comment, as Hermes's is) and one of Bea's in bravo,
// where Bea also decides tasks, so her refusals on alpha's task are the
// business boundary's and not a missing grant's; the calls a case makes; and
// an API on a pool of four for the races, which on the world's one-connection
// pool would queue and never race.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import {
  ACCEPTANCE_ISSUER,
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from './world.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/index.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { testSignIn } from '../support/sign-in.ts';

export const CANARY: string = 'CANARY-2351-delete-reason-7f3a';
export const DAY_MS: number = 24 * 60 * 60 * 1000;

/** Applied: a 404 with no body reads as code `ok` too, so the status is asked as well. */
export const okay = (answer: Answer, label = 'applied'): void => {
  expect(answer.status, `${label}: ${answer.text}`).toBe(200);
  expect(answer.code, label).toBe('ok');
};

type Answering = 'task.confirm_delete' | 'task.decline_delete';

/** The world one test file opens, and the calls its cases make. */
export interface RequestWorld {
  readonly harness: () => Harness;
  readonly bravoSecret: () => string;
  revisionOf(recordId: string): Promise<number>;
  asCredential(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
    businessKey?: string,
  ): Promise<Answer>;
  /** Ada's agent credential asks to delete `recordId` at its current revision. */
  ask(recordId: string, reason?: string): Promise<Answer>;
  answer(
    name: Answering,
    recordId: string,
    caller?: { readonly token: string },
    businessKey?: string,
  ): Promise<Answer>;
  /** The open request the task page is sent, or null. */
  pendingOn(recordId: string): Promise<Record<string, unknown> | null>;
  readCode(recordId: string): Promise<string>;
  /** Ada's command through the four-connection API. */
  asAdaWide(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}

/** Opens the world for one test file: its own harness, credentials and wide API. */
// eslint-disable-next-line max-lines-per-function -- one world, and the calls on it
export function openRequestWorld(part: string): RequestWorld {
  let harness: Harness;
  let secret = '';
  let bravoSecret = '';
  let wide: Database | undefined;
  let wideApi: ReturnType<typeof createApi>;

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await harness.world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where id = $1`,
      [recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  const issueCredential = async (token: string, businessKey: string): Promise<string> => {
    const issued = await call(
      harness.world.api,
      personPath(businessKey, '/credential/issue'),
      {
        operationId: randomUUID(),
        scope: ['read', 'write', 'comment'].map((action) => ({ collection: 'task', action })),
        expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
        purpose: `Hermes in a test ${randomUUID()}`,
      },
      bearer(token),
    );
    expect(issued.code, 'the credential issue').toBe('ok');
    return String((issued.body['detail'] as Record<string, unknown>)['credential']);
  };

  const asCredential: RequestWorld['asCredential'] = async (
    name,
    body,
    credential = secret,
    businessKey = 'alpha',
  ) =>
    await call(
      harness.world.api,
      agentPath(businessKey, pathOf(name)),
      { operationId: randomUUID(), ...body },
      bearer(credential),
    );

  beforeAll(async () => {
    if (serverUrl === undefined) return;
    harness = await createHarness(part);
    const { world } = harness;
    const bea = world.bea as unknown as Member;
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      for (const action of ['read', 'write', 'comment', 'decide'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bea, action, WHOLE_BUSINESS, false, 'task');
      }
      await grantTo(tx, bea, 'write', WHOLE_BUSINESS, false, 'credential');
    });
    secret = await issueCredential(world.ada.token, 'alpha');
    bravoSecret = await issueCredential(world.bea.token, 'bravo');
    wide = connect(world.db.appUrl, { source: 'runtime', max: 4 });
    const byKey: Readonly<Record<string, string>> = { alpha: world.alpha, bravo: world.bravo };
    wideApi = createApi({
      database: wide,
      verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
      resolveBusiness: (key: string) => Promise.resolve(byKey[key]),
      executeCommand,
      executeRead,
      executeAgentCommand,
      executeCredentialCommand,
    });
  }, 120_000);

  afterAll(async () => {
    await wide?.close();
    await harness?.close();
  });

  return {
    harness: () => harness,
    bravoSecret: () => bravoSecret,
    revisionOf,
    asCredential,
    ask: async (recordId, reason = `${CANARY} a test task`) =>
      await asCredential('task.request_delete', {
        recordId,
        expectedRevision: await revisionOf(recordId),
        reason,
      }),
    answer: async (name, recordId, caller = harness.world.ada, businessKey = 'alpha') =>
      await harness.asPerson(
        name,
        { recordId, expectedRevision: await revisionOf(recordId) },
        businessKey,
        caller,
      ),
    pendingOn: async (recordId) => {
      const read = await harness.asPerson('task.read', { recordId });
      expect(read.code, 'the task read').toBe('ok');
      const task = read.body['task'] as Record<string, unknown>;
      return (task['deleteRequest'] ?? null) as Record<string, unknown> | null;
    },
    readCode: async (recordId) => (await harness.asPerson('task.read', { recordId })).code,
    asAdaWide: async (name, body) =>
      await call(
        wideApi,
        personPath('alpha', pathOf(name)),
        { operationId: randomUUID(), ...body },
        bearer(harness.world.ada.token),
      ),
  };
}
