// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- Sol's proof, kept as written */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { authorised, post, tokenFor } from '../api/fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { createClient, revokeGrant } from '../../packages/core-records/src/index.ts';
import { generateSealingPair, setSecret } from '../../packages/core-records/src/custody/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';

const pair = generateSealingPair('sol/373-fix1@1');
let controls: Controls;
let pool: Database;

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeAll(async () => {
  controls = await createControls('sol373fix1', { custody: pair.key });
  pool = connect(controls.fixture.db.appUrl, { max: 2 });
});

afterAll(async () => {
  await pool?.close();
  await controls?.drop();
});

it('a person cannot list client secrets created after their custody grant is revoked', async () => {
  const { db, business } = controls.fixture;
  const seeded = await db.app.withBusiness(business, async (tx) => {
    const client = await createClient(tx, 'Sol revocation client', controls.manager.actorId);
    if (!client.ok) throw new Error('client fixture failed');
    const grant = await grantTo(
      tx,
      controls.reader,
      'manage',
      { kind: 'party', id: client.value },
      false,
      'custody',
    );
    await setSecret(tx, {
      name: 'sol.before-revocation',
      scope: { kind: 'party', id: client.value },
      value: 'before-revocation-key',
      key: pair.key,
      actorId: controls.manager.actorId,
    });
    return { clientId: client.value, grantId: grant };
  });
  const headers = authorised(await tokenFor(controls.reader.presented.subject));
  const control = await post(controls.api, '/api/b/alpha/secret/list', {}, headers);
  expect(control.status).toBe(200);
  expect(JSON.stringify(control.body)).toContain('sol.before-revocation');

  const beforeRows = latch();
  const resume = latch();
  const database: Database = {
    log: pool.log,
    close: async () => {},
    withBusiness: async (id, run) =>
      await pool.withBusiness(
        id,
        async (tx) =>
          await run({
            ...tx,
            query: async <Row>(
              sql: string,
              parameters?: readonly unknown[],
            ): Promise<readonly Row[]> => {
              if (sql.includes('public.custody_secrets')) {
                beforeRows.release();
                await resume.promise;
              }
              return await tx.query<Row>(sql, parameters);
            },
          }),
      ),
  };
  const api = controls.fixture.compose({ custody: pair.key }, undefined, database);
  const pending = post(api, '/api/b/alpha/secret/list', {}, headers);
  const name = `sol.after-revocation-${randomUUID().slice(0, 8)}`;
  try {
    await beforeRows.promise;
    await db.app.withBusiness(business, async (tx) => {
      expect(await revokeGrant(tx, seeded.grantId)).not.toBeNull();
    });
    // This secret did not exist at any time the reader held custody:manage.
    await db.app.withBusiness(business, async (tx) => {
      await setSecret(tx, {
        name,
        scope: { kind: 'party', id: seeded.clientId },
        value: 'after-revocation-key',
        key: pair.key,
        actorId: controls.manager.actorId,
      });
    });
  } finally {
    resume.release();
  }
  const answer = await pending;
  const nextCall = await post(controls.api, '/api/b/alpha/secret/list', {}, headers);
  expect(nextCall.status).toBe(403);
  expect(
    JSON.stringify(answer.body),
    'the list must not expose a secret created only after custody authority ended',
  ).not.toContain(name);
});

it('an out-of-range expectedRevision is refused by field instead of faulting', async () => {
  const { db, business } = controls.fixture;
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, controls.manager, 'manage', { kind: 'business', id: null }, false, 'custody');
  });
  const headers = authorised(await tokenFor(controls.manager.presented.subject));
  const body = { name: 'sol.big-revision', value: 'big-revision-test-key' };
  const control = await post(
    controls.api,
    '/api/b/alpha/secret/set',
    { ...body, operationId: randomUUID() },
    headers,
  );
  expect(control.status).toBe(200);
  const answer = await post(
    controls.api,
    '/api/b/alpha/secret/set',
    { ...body, operationId: randomUUID(), expectedRevision: 1e20 },
    headers,
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
  expect(answer.body['names']).toStrictEqual(['expectedRevision']);
});
