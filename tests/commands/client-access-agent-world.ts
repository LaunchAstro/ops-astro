// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-10 isolation: client access under a live
// delegation” cases: the database, the people and the helpers they read, set up
// once per test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { agentWorld, type AgentWorld } from './agent-fixture.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const CANARY: string = `canary-${randomUUID()}`;

export const SHARE = 'task.share_with_client';

export const REVOKE = 'task.revoke_client_share';

export const outcomeOf: (
  answer: CommandResult | Awaited<ReturnType<typeof executeRead>>,
) => Readonly<Record<string, unknown>> = (
  answer: CommandResult | Awaited<ReturnType<typeof executeRead>>,
) => (isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true });

/** The shares a task carries: live record-scoped `task:read` rows, by holder. */
export const SHARES_SQL = `select subject_id as person_id, granted_by_actor_id, revoked_at is null as live
                      from public.grants
                     where scope_kind = 'record' and scope_id = $1 and subject_kind = 'person'
                       and collection = 'task' and action = 'read'
                     order by granted_at`;

export interface ShareRow {
  readonly person_id: string;
  readonly granted_by_actor_id: string;
  readonly live: boolean;
}

export let world: AgentWorld;

export async function setUp(): Promise<void> {
  world = await agentWorld('hca', `access-agent-${randomUUID().slice(0, 8)}`);
}

export async function tearDown(): Promise<void> {
  await world?.drop();
}
