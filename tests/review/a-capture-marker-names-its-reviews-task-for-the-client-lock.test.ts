// SPDX-License-Identifier: AGPL-3.0-only
//
// S2061-6 (Sol's proof): review.capture writes only review_captures, which name a
// revision, not a task. The client-lock harness has to follow capture to revision to
// review to find the task the capture is content of.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { markerFaults, useHarness } from '../operations/s0-5-client-lock-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
let h: Harness;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  h = await createHarness('capturemarker');
  useHarness(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe.skipIf(serverUrl === undefined)('the review capture content marker', () => {
  it('a capture is traced through its revision and review to the task it is content of', async () => {
    expect(await markerFaults(declarationOf('review.capture'))).toStrictEqual([]);
  }, 120_000);
});
