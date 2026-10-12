// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's name is read by everyone who reads a task it holds, so it holds
// no character that draws nothing, breaks a line or reorders the text around
// it: no C0 or C1 control, DEL, line or paragraph separator, or bidi mark,
// embedding, override or isolate. `agentNameOf` refuses them before a write,
// and the actors table's own check refuses them when a row is written past
// it. Accented letters and an emoji built with the joiner stay.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentNameOf } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const REFUSED: readonly (readonly [string, string])[] = [
  ['a C0 control', 'Reply\u0007drafter'],
  ['DEL', 'Reply\u007Fdrafter'],
  ['a C1 control (NEXT LINE)', 'Reply\u0085drafter'],
  ['a C1 control (CSI)', 'Reply\u009Bdrafter'],
  ['a line separator', 'Reply\u2028drafter'],
  ['a right-to-left override', 'Reply\u202Edrafter'],
  ['a right-to-left mark', 'Reply\u200Fdrafter'],
  ['a first-strong isolate', 'Reply\u2068drafter'],
];

const KEPT = ['Rédacteur à Zoë', 'Helper 👩\u200D💻'];

describe('An agent name holds no control or direction character', () => {
  it.each(REFUSED)('a name carrying %s is refused', (_, name) => {
    expect(agentNameOf(name)).toBeUndefined();
  });

  it.each(KEPT)('the name %s is kept', (name) => {
    expect(agentNameOf(name)).toBe(name);
  });
});

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('agent name column check: DATABASE_URL is unset.');

let db: FreshDatabase | undefined;
let business = '';
beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'agentname' });
  business = await insertBusiness(db.app, `agentname-${randomUUID().slice(0, 8)}`);
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

/** An agent row written directly, past `agentNameOf`. */
async function writeAgentNamed(name: string): Promise<void> {
  await db?.app.withBusiness(business, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, display_name) values ($1, $2, 'agent', $3)`,
      [business, randomUUID(), name],
    );
  });
}

describe.skipIf(serverUrl === undefined)('The actors table checks an agent name itself', () => {
  it.each(REFUSED)('a row naming an agent with %s is refused', async (_, name) => {
    await expect(writeAgentNamed(name)).rejects.toThrow(/actors_display_name_shape/u);
  });

  it.each(KEPT)('a row naming an agent %s is kept', async (name) => {
    await expect(writeAgentNamed(name)).resolves.toBeUndefined();
  });
});
