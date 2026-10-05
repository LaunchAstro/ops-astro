// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  generateSealingPair,
  markSecretUsed,
  readSecret,
  setSecret,
} from '../../packages/core-records/src/custody/index.ts';

let controls: Controls;
let pool: Database;
const pair = generateSealingPair('sol/373-last-used@1');

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeAll(async () => {
  controls = await createControls('sol373lastused', { custody: pair.key });
  pool = connect(controls.fixture.db.appUrl, { max: 2 });
});

afterAll(async () => {
  await pool?.close();
  await controls?.drop();
});

it('an older transaction using a secret later must not move its last-used time backwards', async () => {
  const { db, business } = controls.fixture;
  const secret = await db.app.withBusiness(
    business,
    async (tx) =>
      await setSecret(tx, {
        name: 'sol.last-used',
        scope: { kind: 'business', id: null },
        value: 'last-used-test-key',
        key: pair.key,
        actorId: controls.manager.actorId,
      }),
  );
  if (!('id' in secret)) throw new Error('secret fixture failed');
  const started = latch();
  const resume = latch();
  const older = pool.withBusiness(business, async (tx) => {
    // Separate transaction start times by more than Date's millisecond resolution.
    await tx.query('select pg_sleep(0.02)');
    started.release();
    await resume.promise;
    expect(await markSecretUsed(tx, secret.id)).toBe(true);
  });
  let firstUse: number | undefined;
  try {
    await started.promise;
    firstUse = await pool.withBusiness(business, async (tx) => {
      expect(await markSecretUsed(tx, secret.id)).toBe(true);
      return (await readSecret(tx, secret.id))?.lastUsedAt?.getTime();
    });
  } finally {
    resume.release();
    await older;
  }
  const lastUse = await db.app.withBusiness(business, async (tx) =>
    (await readSecret(tx, secret.id))?.lastUsedAt?.getTime(),
  );
  expect(firstUse).toBeTypeOf('number');
  if (firstUse === undefined) throw new Error('the first use has no timestamp');
  expect(
    lastUse,
    'the later committed use must not erase the newer last-used timestamp',
  ).toBeGreaterThanOrEqual(firstUse);
});
