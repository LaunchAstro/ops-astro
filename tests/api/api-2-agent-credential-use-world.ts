// SPDX-License-Identifier: AGPL-3.0-only
//
// What API-2's use cases share, over `api-2-agent-credential-world.ts`: a
// credential issued for reading and commenting, a call on the agent route
// with whatever credential a case presents, the world's own composition with a
// clock or a verifier of the case's choosing, and the counts a case reads back.

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { createApi, type ApiOptions } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_HEADER,
  pathOf,
  type CommandName,
} from '../../packages/core-wire/src/index.ts';
import { testSignIn } from '../support/sign-in.ts';
import { ACCEPTANCE_ISSUER, agentPath, call, type Answer } from '../acceptance/world.ts';
import { detailOf, harness, issue, issueBody } from './api-2-agent-credential-world.ts';

export type Api = ReturnType<typeof createApi>;

export const COMMENT_SCOPE: readonly { readonly collection: string; readonly action: string }[] = [
  { collection: 'task', action: 'read' },
  { collection: 'task', action: 'comment' },
];

export interface Issued {
  readonly secret: string;
  readonly id: string;
}

/** A credential issued through the API, for reading and commenting unless `overrides` say. */
export async function issued(
  overrides: Readonly<Record<string, unknown>> = {},
  token: string = harness.world.ada.token,
): Promise<Issued> {
  const answer = await issue(issueBody({ scope: COMMENT_SCOPE, ...overrides }), token);
  expect(answer.code, 'the issue').toBe('ok');
  const detail = detailOf(answer);
  return { secret: String(detail['credential']), id: String(detail['credentialId']) };
}

async function revisionOf(recordId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

/** One agent-route call; `headers` carry whatever credential the case presents. */
export const asCredential = async (
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
  headers: Record<string, string>,
  api: Api = harness.world.api,
  businessKey = 'alpha',
): Promise<Answer> =>
  await call(
    api,
    agentPath(businessKey, pathOf(name)),
    { operationId: randomUUID(), ...body },
    headers,
  );

/** A comment on alpha's task at its current revision. */
export const comment = async (
  headers: Record<string, string>,
  api: Api = harness.world.api,
  businessKey = 'alpha',
): Promise<Answer> => {
  const recordId = harness.alphaTask.id;
  const body = {
    recordId,
    expectedRevision: await revisionOf(recordId),
    body: `from the agent ${randomUUID()}`,
    audience: 'internal',
  };
  return await asCredential('task.comment', body, headers, api, businessKey);
};

/** Applied `task.comment` events whose actor is this credential's agent. */
export async function agentComments(credentialId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.audit_events e
       join public.agent_credentials c
         on c.business_id = e.business_id and c.agent_actor_id = e.actor_id
      where c.id = $1 and e.command = 'task.comment' and e.outcome = 'applied'`,
    [credentialId],
  );
  return Number(rows[0]?.n ?? '-1');
}

/** The world's own composition, with a clock, limits or a verifier of the case's choosing. */
export function apiWith(overrides: Partial<ApiOptions>): Api {
  const byKey: Readonly<Record<string, string>> = {
    alpha: harness.world.alpha,
    bravo: harness.world.bravo,
  };
  return createApi({
    database: harness.world.db.app,
    verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
    resolveBusiness: (key: string) => Promise.resolve(byKey[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    executeCredentialCommand,
    ...overrides,
  });
}

const lines: string[] = [];
const keep = (...parts: unknown[]): void => {
  lines.push(
    parts.map((part) => (part instanceof Error ? String(part.stack) : String(part))).join(' '),
  );
};

/** Every line written to the console while `run` runs, as one text. */
export async function consoleDuring(run: () => Promise<void>): Promise<string> {
  lines.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(keep);
  }
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join('\n');
}

/** The fixes a refusal carries, as one text to read. */
export const wordsOf = (answer: Answer): string =>
  ((answer.body['fixes'] ?? []) as readonly string[]).join(' ');

/** A token carried as the browser's session cookie, as `auth/session.ts` names it. */
export function cookieOf(token: string): Record<string, string> {
  const id = createHash('sha256').update(token).digest('hex').slice(0, 32);
  return { cookie: `${SESSION_COOKIE}-${id}=${token}`, [SESSION_HEADER]: id, [CSRF_HEADER]: '1' };
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An HS256 token, the scheme the product no longer holds a secret for. */
export function hs256(claims: Readonly<Record<string, unknown>>, secret: string): string {
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/** A promise and the call that settles it. */
export function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  const settle: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settle.push(resolve);
  });
  return { promise, open: () => settle[0]?.() };
}
