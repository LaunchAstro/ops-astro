// SPDX-License-Identifier: AGPL-3.0-only
//
// #2154: a capture asked with no revisionId is the caller's own omission, refused for that
// field. Answered NOT_FOUND, the inventory read the command as an unrouted one. A malformed
// id still names nothing, as a fabricated one does, and neither stores a capture.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 capture field: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35nocap');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('review.capture with no revisionId', () => {
  it('is refused for its field, and a malformed id as not found', async () => {
    const captures = await w.count('review_captures', w.world.business);

    const missing = await w.asIn(w.world.business, w.ava, { command: 'review.capture' });
    expect(codeOf(missing)).toBe('FIELD_VALUE_INVALID');
    expect(isCommandRefusal(missing) ? missing.names : []).toStrictEqual(['revisionId']);
    expect(codeOf(await w.capture(w.ava, 'not-an-id'))).toBe('NOT_FOUND');

    expect(await w.count('review_captures', w.world.business)).toBe(captures);
  });
});
