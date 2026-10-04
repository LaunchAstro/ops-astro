// SPDX-License-Identifier: AGPL-3.0-only
//
// What API-2's quota cases share (`api-2-agent-credential-quota.test.ts` and
// `api-2-agent-credential-door.test.ts`): the world's composition with small
// limits and a clock the case moves, a read on the agent route with a given
// bearer, a reader in Bravo for the per-business controls, and the codes a
// burst settled on.

import { expect } from 'vitest';
import type { AgentLimits } from '../../apps/api/auth/agent-quota.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { bearer, type Answer } from '../acceptance/world.ts';
import { detailOf, harness, issue, issueBody } from './api-2-agent-credential-world.ts';
import { apiWith, asCredential, type Api } from './api-2-agent-credential-use-world.ts';

export const WIDE: AgentLimits['requests'] = { credential: 1000, person: 1000, business: 1000 };

export function limited(
  overrides: Partial<AgentLimits>,
  database: Database = harness.world.db.app,
): { api: Api; tick: (ms: number) => void } {
  let clock = Date.now();
  const api = apiWith({
    database,
    agentCredentials: {
      now: () => new Date(clock),
      limits: { requests: WIDE, concurrent: WIDE, exports: WIDE, refused: 1000, ...overrides },
    },
  });
  return { api, tick: (ms) => (clock += ms) };
}

export const readWith = async (api: Api, secret: string): Promise<Answer> =>
  await asCredential('task.read', { recordId: harness.alphaTask.id }, bearer(secret), api);

/** Answers' codes, sorted, so a burst reads the same whatever order it settled in. */
export const codesOf = (answers: readonly Answer[]): string[] =>
  answers.map((answer) => answer.code).toSorted();

/** A read credential of Bea's in Bravo, a business apart from Alpha's counts. */
export async function bravoReader(): Promise<string> {
  const answer = await issue(
    issueBody({ scope: [{ collection: 'task', action: 'read' }] }),
    harness.world.bea.token,
    'bravo',
  );
  expect(answer.code, 'Bravo can issue a read credential').toBe('ok');
  return String(detailOf(answer)['credential']);
}

/** A read of Bravo's record on Bravo's agent route. */
export const readInBravo = async (api: Api, secret: string): Promise<Answer> =>
  await asCredential(
    'task.read',
    { recordId: harness.bravoRecordId },
    bearer(secret),
    api,
    'bravo',
  );
