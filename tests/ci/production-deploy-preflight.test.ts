// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's deploy preflight. Production holds real businesses and real
// sign-ins, which staging's made-up-only preflight refuses by design. So
// production's asks the opposite question: did the made-up seed or its guard
// ever run here? It answers from the seed's own mark, guard schema and watch,
// and reads no business, person or sign-in row. A database holding a real
// sign-in passes it, and fails staging's; one the seed marked fails it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { productionPreflight, stagingSigns } from '../../scripts/ops/deploy.ts';
import {
  madeUpSeedSigns,
  markMadeUp,
  productionSigns,
  type OwnerQuery,
} from '../../scripts/ops/made-up-only.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { businessRow, serverUrl } from './staging-no-production-data.fixture.ts';

it("production's preflight reads no business, person or sign-in row", async () => {
  const statements: string[] = [];
  const owner: OwnerQuery = {
    execute<Row>(statement: string): Promise<readonly Row[]> {
      statements.push(statement);
      return Promise.resolve([{ yes: false, mark: null }] as Row[]);
    },
  };
  expect(await madeUpSeedSigns(owner)).toStrictEqual([]);
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    expect(statement).not.toMatch(/\b(?:public|auth|ops)\.[a-z_]+/u);
  }
});

let db: FreshDatabase;

describe.skipIf(serverUrl === undefined)("production's deploy preflight, on a database", () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'prodpre' });
    const url = new URL(serverUrl!);
    url.pathname = `/${db.name}`;
    vi.stubEnv('DATABASE_ADMIN_URL', url.toString());
    await db.admin.execute('create schema if not exists auth');
    await db.admin.execute('create table if not exists auth.users (id uuid, email text)');
    await businessRow(db.admin, 'harbour-real-business');
    await db.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
      randomUUID(),
      'someone@example.com',
    ]);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('passes a database holding a real sign-in, which staging’s preflight refuses', async () => {
    expect(await madeUpSeedSigns(db.admin)).toStrictEqual([]);
    expect(await productionPreflight()).toStrictEqual([]);
    expect(await productionSigns(db.admin)).toContain('it carries no made-up mark');
    expect(await stagingSigns()).toContain('it carries no made-up mark');
  });

  it('refuses a database the made-up seed marked and guarded', async () => {
    await markMadeUp(db.admin, []);
    const signs = [
      'it carries the made-up mark',
      'the made-up guard is installed',
      "the made-up guard's watch is installed",
    ];
    expect(await madeUpSeedSigns(db.admin)).toStrictEqual(signs);
    expect(await productionPreflight()).toStrictEqual(signs);
  });
});
