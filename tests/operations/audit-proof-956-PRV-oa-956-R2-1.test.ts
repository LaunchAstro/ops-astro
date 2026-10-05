// SPDX-License-Identifier: AGPL-3.0-only
//
// Audit proof PRV-oa-956-R2.1: an unrelated record holding a large string must
// not abort the privacy inventory of a person found by their stored name.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { findCopies } from './c81-privacy-runbook-finder.ts';

const test = it.skipIf(serverUrl === undefined);
let harness: Harness;
let adminUrl: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('prv_956_r2_1');
  const url = new URL(process.env['DATABASE_ADMIN_URL'] ?? serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  adminUrl = url.toString();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

test('Audit proof, criterion correctness: a large unrelated record does not abort the inventory', async () => {
  const { world } = harness;
  const person = randomUUID();
  const type = randomUUID();
  const record = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Anna Current')`,
      [world.alpha, person],
    );
    await tx.query(
      `insert into public.record_types (business_id, id, key, name, origin, retention_class)
       values ($1, $2, 'sol_large_value', 'Large value', 'preset', 'work')`,
      [world.alpha, type],
    );
    await tx.query(
      `insert into public.records (business_id, id, record_type_id, data)
       select $1, $2, $3, jsonb_build_object('payload',
         (select string_agg('w' || lpad(i::text, 8, '0'), ' ' order by i)
            from generate_series(1, 300000) i))`,
      [world.alpha, record, type],
    );
  });

  const found = await findCopies(adminUrl, ['--text', 'Anna Current', '--export'], 'alpha');

  expect(found.stderr).not.toContain('the search failed');
  expect(found.code).toBe(0);
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  expect(pairs, "A's people row is in the inventory").toContainEqual(['people', person]);
  expect(pairs, 'the unrelated record is not').not.toContainEqual(['records', record]);
}, 180_000);
