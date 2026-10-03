// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';

const scope = { business: randomUUID(), person: randomUUID(), client: randomUUID() };

test('a second seed admission cannot invalidate the first seed session', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must name a reviewer-owned throwaway cluster');
  const root = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const database = `sol_ow064_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  let first;
  let second;
  let secondAdmission;
  try {
    await root.unsafe(`create database ${database}`);
    first = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    second = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const ownerA = { execute: (sql, parameters = []) => first.unsafe(sql, parameters) };
    const ownerB = { execute: (sql, parameters = []) => second.unsafe(sql, parameters) };
    await ownerA.execute('create table public.records (business_id uuid, title text)');
    const a = await import(new URL('../../scripts/ops/made-up-only.ts?sol-ow064-seed-a', import.meta.url));
    const b = await import(new URL('../../scripts/ops/made-up-only.ts?sol-ow064-seed-b', import.meta.url));
    assert.notEqual(a.SEED_TAG, b.SEED_TAG, 'two seed processes have separate secrets');
    await a.bindSeed(ownerA);
    assert.deepEqual(await a.admitMadeUp(ownerA, true), [], 'the first seed is admitted');
    await b.bindSeed(ownerB);
    secondAdmission = b.admitMadeUp(ownerB, true);
    // A fix may refuse B or hold it until A closes. The current head admits B
    // immediately and replaces A's digest; do not require that unsafe outcome.
    await Promise.race([
      secondAdmission,
      new Promise((done) => { setTimeout(done, 1500); }),
    ]);
    await ownerA.execute(`insert into public.records select $1::uuid, 'made-up first-seed task' from ${a.SEED_TAG}`,
      [scope.business]);
    await a.markMadeUp(ownerA, [scope.business]);
    assert.deepEqual(await a.productionSigns(ownerA), [],
      'a genuine bound seed write must not be permanently recorded as untrusted by another seed admission');
  } finally {
    await first?.end();
    await secondAdmission?.catch(() => {});
    await second?.end();
    await root.unsafe(`drop database if exists ${database} with (force)`);
    await root.end();
  }
});
