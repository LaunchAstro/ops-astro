// SPDX-License-Identifier: AGPL-3.0-only
//
// #2154: a pin sent with no revisionId is the caller's own omission, refused for that field.
// Answered NOT_FOUND, the inventory read the command as an unrouted one. A malformed id still
// names nothing, as a fabricated one does, and neither keeps a pin.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pin field: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35nopin');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('review.pin_comment with no revisionId', () => {
  it('is refused for its field, and a malformed id as not found', async () => {
    const pins = await w.count('pins', w.world.business);

    const missing = await w.asIn(w.world.business, w.ava, {
      command: 'review.pin_comment',
      width: 1480,
      selector: [spot()],
      body: 'Move this heading above the fold',
      audience: 'internal',
    });
    expect(codeOf(missing)).toBe('FIELD_VALUE_INVALID');
    expect(isCommandRefusal(missing) ? missing.names : []).toStrictEqual(['revisionId']);
    expect(codeOf(await w.pin(w.ava, 'not-an-id'))).toBe('NOT_FOUND');

    expect(await w.count('pins', w.world.business)).toBe(pins);
  });
});
