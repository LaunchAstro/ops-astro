// SPDX-License-Identifier: AGPL-3.0-only
// S0-1e: the operator gate and the deployment record (ticket S0-1, line A4).
//
// The person-only commands, staging preparation (`scripts/ops/operator.mjs
// prepare`), the staging deploy (`scripts/ops/deploy.mjs`, `S0-6 operator
// only`), the promotion step (`scripts/ops/promote.mjs`) and the restore
// drill (`scripts/ops/restore-drill.mjs --drill`, `S0-3 operator only`), run
// through one check: a person's own sign-in, in the business named, holding
// `operations:manage` on the whole business. An agent credential, a call under
// a delegation, a person without the key, another business's operator and a
// client-scoped grant are each refused before the command acts: the service
// manager is never asked, the production link does not move and no deployment
// record is written. The commands run as the owner runs them, over a real
// database and a PATH whose docker and launchctl log every call.
//
// The fixtures are operator-only.fixture.ts. The operator's own acts continue
// in operator-only-acts.test.ts and operator-only-promotion.test.ts.

import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  token,
  subjects,
  environment,
  CALLERS,
  operatorOnlyHooks,
} from './operator-only.fixture.ts';
import { scratch, manager, marks, COMMANDS, CANARY } from './operator-only-commands.fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';

let db: FreshDatabase;
let alphaBusiness = '';
let operatorPerson = '';

describe('S0-1 operator only, before any lookup', () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    it(`${name} with no sign-in is refused and asks nothing of the machine`, () => {
      const fake = manager(false);
      const at = marks(fake);
      const result = command(
        {
          PATH: fake.path,
          OPS_ASTRO_DEPLOYMENTS: at.records,
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never',
          DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@127.0.0.1:1/never`,
        },
        at,
      );
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/operations:manage/u);
      expect(result.out).not.toMatch(/ECONNREFUSED|db-migrate/u);
      expect(result.out).not.toContain(CANARY);
      expect(existsSync(at.calls)).toBe(false);
      expect(readdirSync(at.records)).toEqual([]);
      expect(readlinkSync(at.current)).toBe(join(scratch, 'previous-build'));
    });
  }
});

describe.skipIf(serverUrl === undefined)('S0-1 operator only', () => {
  operatorOnlyHooks((state) => ({ db, alphaBusiness, operatorPerson } = state));

  operatorOnlyCases1();
  operatorOnlyCases2();
});

function operatorOnlyCases1() {
  for (const [commandName, command] of Object.entries(COMMANDS)) {
    for (const [callerName, caller] of Object.entries(CALLERS)) {
      it(`${commandName}, run by ${callerName}: refused before it acts, and writes nothing`, async () => {
        const fake = manager(false);
        const at = marks(fake);
        const own = await caller();
        const result = command(environment(at, fake.path, own), at);
        expect(result.status, result.out).toBe(1);
        expect(result.out).toMatch(/operations:manage/u);
        expect(result.out).not.toMatch(
          /db-migrate|promotion recorded|staging prepared|deploy recorded|restore drill recorded|"outcome"/u,
        );
        for (const secret of [CANARY, own['OPS_ASTRO_TOKEN'] ?? CANARY]) {
          expect(result.out).not.toContain(secret);
        }
        expect(existsSync(at.calls), 'the service manager was asked').toBe(false);
        expect(readdirSync(at.records)).toEqual([]);
        expect(readlinkSync(at.current)).toBe(join(scratch, 'previous-build'));
      });
    }
  }

  Object.entries(COMMANDS).forEach(([commandName, command]) => {
    it(`refused ${commandName} writes no authentication row`, async () => {
      const count = async (): Promise<number> =>
        await db.app.withBusiness(alphaBusiness, async (tx) => {
          const rows = await tx.query<{ n: number }>(
            'select count(*)::int as n from authentication_attempts where business_id = $1',
            [tx.businessId],
          );
          return rows[0]!.n;
        });
      const before = await count();
      const fake = manager(false);
      const at = marks(fake);
      const result = command(
        environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.keyless) }),
        at,
      );
      expect(result.status, result.out).toBe(1);
      expect(await count()).toBe(before);
    });
  });
}

function operatorOnlyCases2() {
  Object.entries(COMMANDS).forEach(([commandName, command]) => {
    it(`refused ${commandName} without a record folder writes no authentication row`, async () => {
      const count = async (): Promise<number> =>
        await db.app.withBusiness(alphaBusiness, async (tx) => {
          const rows = await tx.query<{ n: number }>(
            'select count(*)::int as n from authentication_attempts where business_id = $1',
            [tx.businessId],
          );
          return rows[0]!.n;
        });
      const before = await count();
      const fake = manager(false);
      const at = marks(fake);
      const env = environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) });
      delete (env as Partial<typeof env>).OPS_ASTRO_DEPLOYMENTS;
      const result = command(env, at);
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/OPS_ASTRO_DEPLOYMENTS/u);
      expect(await count()).toBe(before);
    });
  });

  it('the operator prepares staging: the one command runs, and one record names the operator', async () => {
    const fake = manager(false);
    const at = marks(fake);
    const signIn = await token(subjects.operator);
    const result = COMMANDS['staging preparation']!(
      environment(at, fake.path, { OPS_ASTRO_TOKEN: signIn }),
      at,
    );
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(at.calls, 'utf8')).toMatch(/^docker compose .*compose\.json.* create/mu);
    const records = readFileSync(join(at.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(1);
    const record = JSON.parse(records[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      action: 'staging prepared',
      business: 'alpha',
      operator: operatorPerson,
    });
    expect(Date.parse(record['at'] as string)).not.toBeNaN();
    expect(records[0]).not.toContain(signIn);
    expect(result.out).not.toContain(signIn);
  });
}
