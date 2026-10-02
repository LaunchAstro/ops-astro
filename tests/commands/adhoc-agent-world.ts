// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-10 isolation: ad hoc under a live delegation”
// cases: the database, the people and the helpers they read, set up once per
// test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { agentWorld, type AgentWorld } from './agent-fixture.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const CANARY: string = `canary-${randomUUID()}`;

export const outcomeOf: (answer: CommandResult) => Readonly<Record<string, unknown>> = (
  answer: CommandResult,
) => (isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true });

export let world: AgentWorld;

export const revision: (recordId: string) => Promise<number> = async (recordId: string) =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

export const markOf: (recordId: string) => Promise<boolean | null | undefined> = async (
  recordId: string,
) =>
  (
    await world.db.admin.execute<{ readonly ad_hoc: boolean | null }>(
      `select bool_2 as ad_hoc from public.records where id = $1`,
      [recordId],
    )
  )[0]?.ad_hoc;

export async function setUp(): Promise<void> {
  world = await agentWorld('ha', `adhoc-agent-${randomUUID().slice(0, 8)}`);
}

export async function tearDown(): Promise<void> {
  await world?.drop();
}
