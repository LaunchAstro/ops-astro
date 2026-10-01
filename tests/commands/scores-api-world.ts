// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-9 marks command on the API and command line”
// cases: the database, the people and the helpers they read, set up once per
// test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import type { Hono } from 'hono';

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { RefusalCode } from '../../packages/core-records/src/register.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { createApiFixture, tokenFor, type ApiFixture } from '../api/fixture.ts';

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

export let fixture: ApiFixture;

export let api: Hono;

export let credential: string;

export async function setUp(): Promise<void> {
  fixture = await createApiFixture('s');
  api = fixture.compose();
  credential = await tokenFor(fixture.member.presented.subject);
}

export async function tearDown(): Promise<void> {
  await fixture?.drop();
}
