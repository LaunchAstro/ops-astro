// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-9 marks command for an agent” cases: the
// database, the people and the helpers they read, set up once per test file
// that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { RefusalCode } from '../../packages/core-records/src/register.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { agentWorld, type AgentWorld } from './agent-fixture.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export type Request = Parameters<typeof executeCommand>[4];

export const outcomeOf: (answer: CommandResult) =>
  | {
      code: RefusalCode;
      names: readonly string[];
      applied?: never;
    }
  | { code?: never; names?: never; applied: boolean } = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

export let world: AgentWorld;

export const revisionOf: (recordId: string) => Promise<number> = async (recordId: string) =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where business_id = $1 and id = $2`,
        [world.business, recordId],
      )
    )[0]?.revision,
  );

export async function setUp(): Promise<void> {
  world = await agentWorld('s', 'task-scores-agent');
}

export async function tearDown(): Promise<void> {
  await world?.drop();
}
