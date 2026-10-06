// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: every refusal of the click-through seed comes before its first
// write. On a database local-seed has cast, each case below is refused and
// leaves the tables, the made-up guard and the mark exactly as they were:
// an address that reaches another database, a role past row security, a
// missing or half key, another run in progress, an item left halfway, and a
// guard ledger with an entry.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase } from '../support/fresh-database.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  ada,
  adminUrlOf,
  closeWorld,
  guardState,
  openCast,
  runSeed,
  SEED,
  serverUrl,
  snapshot,
  type Cast,
  type Ran,
  type SeedOptions,
} from './click-through-seed.fixture.ts';

let cast: Cast;
let empty: string;

/** Run the seed with `options` over the cast, and prove it refused and wrote nothing. */
async function refusedUnchanged(options: Partial<SeedOptions>, words: RegExp): Promise<Ran> {
  const was = [await snapshot(cast.db), await guardState(cast.db)];
  const ran = runSeed(SEED, { admin: cast.db, local: cast.local, ...options });
  expect(ran.status, ran.out).toBe(1);
  expect(ran.out).toMatch(/click-through-seed: REFUSED/u);
  expect(ran.out).toMatch(words);
  expect([await snapshot(cast.db), await guardState(cast.db)]).toEqual(was);
  return ran;
}

describe.skipIf(serverUrl === undefined)('SR-1 click-through seed refusals', () => {
  beforeAll(async () => {
    cast = await openCast('sr1clickrefuse');
    empty = mkdtempSync(join(tmpdir(), 'sr1-empty-'));
  }, 300_000);

  afterAll(async () => {
    if (empty !== undefined) rmSync(empty, { recursive: true, force: true });
    await closeWorld(cast);
  });

  addressAndKeyCases();
  runCases();
});

function addressAndKeyCases() {
  it('refuses a DATABASE_URL that reaches another database, writing to neither', async () => {
    const other = await createFreshDatabase({ part: 'sr1clickother' });
    try {
      const otherWas = [await snapshot(other), await guardState(other)];
      await refusedUnchanged({ appUrl: other.appUrl }, /does not reach the database judged/u);
      expect([await snapshot(other), await guardState(other)]).toEqual(otherWas);
    } finally {
      await other.drop();
    }
  }, 120_000);

  it('refuses a DATABASE_URL whose role is the database owner', async () => {
    await refusedUnchanged({ appUrl: adminUrlOf(cast.db) }, /DATABASE_URL's role/u);
  });

  it('refuses with no gate key and writes nothing', async () => {
    await refusedUnchanged({ local: empty }, /gate signing key/u);
  });

  it('refuses a gate key half from the environment', async () => {
    await refusedUnchanged({ env: { GATE_SIGNING_KEY_ID: 'made-up/half@1' } }, /gate signing key/u);
  });
}

function runCases() {
  it('refuses a delegation keyring that is not there, and never makes one', async () => {
    const file = join(empty, 'absent-delegation.env');
    await refusedUnchanged({ env: { DELEGATION_CREDENTIAL_KEY_FILE: file } }, /delegation/u);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses while another click-through seed holds its lock', async () => {
    const holder = connectAsAdmin(adminUrlOf(cast.db), { source: 'seed' });
    try {
      await holder.execute(`select pg_advisory_lock(hashtext('ops-astro click-through seed'))`);
      await refusedUnchanged({}, /another click-through seed is running/u);
    } finally {
      await holder.close();
    }
  });

  it('refuses an item whose task is there without its end state, naming it', async () => {
    const made = await executeCommand(cast.db.app, cast.business, ada(cast), 'api', {
      command: 'task.create',
      operationId: `made-up:${randomUUID()}`,
      fields: { title: 'Research venue options' },
    } as never);
    expect('code' in made, JSON.stringify(made)).toBe(false);
    await refusedUnchanged({}, /'Research venue options' .*reset/u);
  });

  it('refuses a marked database whose guard ledger names an entry', async () => {
    const id = randomUUID();
    await cast.db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $2)',
      [id, 'made-up-canary'],
    );
    await refusedUnchanged({}, /not provably made-up data/u);
  });
}
