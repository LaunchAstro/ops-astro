// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-9 isolation: an agent under a live delegation”
// cases: the database, the people and the helpers they read, set up once per
// test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

import { agentWorld, type AgentWorld } from '../commands/agent-fixture.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export type Body = Readonly<Record<string, unknown>>;

export type Marks = readonly [number | null, number | null, number | null];

export const CANARY: string = `canary-${randomUUID()}`;

export let world: AgentWorld;

export async function setUp(): Promise<void> {
  world = await agentWorld('rk', `rank-agent-${randomUUID().slice(0, 8)}`);
}

export async function tearDown(): Promise<void> {
  await world?.drop();
}
