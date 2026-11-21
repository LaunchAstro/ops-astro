// SPDX-License-Identifier: AGPL-3.0-only
//
// #2512: run whole, `d06-generated.test.ts` died of a worker heap out of
// memory after 20,423 of 23,583 cells. The fixture's statement log kept every
// statement the run sent, about 100 KB a cell: a heap snapshot at cell 1,150
// held some 218,000 more log entries than at cell 150, and their SQL text was
// the largest growth. A proof that reads the log (c58, cq-2) needs all of it,
// so the default stays whole; a world asked to keep N keeps at least the
// newest N and at most 2N, as the product's own connections do (`driver.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import { serverUrl } from './world.ts';

const SENT = 100;

/** `SENT` statements on the admin connection, the last naming `marker`. */
async function sendMany(harness: Harness, marker: string): Promise<void> {
  for (let i = 1; i < SENT; i++) {
    // eslint-disable-next-line no-await-in-loop -- one connection, in order
    await harness.world.db.admin.execute(`select ${String(i)} as n`);
  }
  await harness.world.db.admin.execute(`select '${marker}' as marker`);
}

describe.skipIf(serverUrl === undefined)('the d06 statement log', () => {
  let bounded: Harness;
  let whole: Harness;

  beforeAll(async () => {
    bounded = await createHarness('d06k', { keepStatements: 10 });
    whole = await createHarness('d06w');
  }, 240_000);

  afterAll(async () => {
    await bounded?.close();
    await whole?.close();
  });

  it('keeps at least the newest N and at most 2N statements when asked to keep N', async () => {
    const marker = `d06k-${randomUUID()}`;
    await sendMany(bounded, marker);
    const { entries } = bounded.world.db.log;
    expect(entries.length).toBeGreaterThanOrEqual(10);
    expect(entries.length).toBeLessThanOrEqual(20);
    expect(entries.at(-1)?.text).toContain(marker);
  });

  it('keeps every statement by default, for the proofs that read the whole log', async () => {
    const from = whole.world.db.log.entries.length;
    const marker = `d06w-${randomUUID()}`;
    await sendMany(whole, marker);
    const since = whole.world.db.log.entries.slice(from);
    expect(since).toHaveLength(SENT);
    expect(since.at(-1)?.text).toContain(marker);
  });
});
