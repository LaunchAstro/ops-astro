// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 quota at the door: made-up bearers on a business key are limited per
// business before they are resolved, so past a full door one costs a single
// read, takes no lock and writes no attempt row, while a live credential is
// still served; the lookup itself is served by an index. The per-credential,
// per-person and per-business limits are in `api-2-agent-credential-quota.test.ts`.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { issued, type Api } from './api-2-agent-credential-use-world.ts';
import { codesOf, limited, readWith } from './api-2-agent-credential-quota-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);

needsServer(
  'API-2 quota at the door: made-up bearers on a business key are limited before they are resolved',
  async () => {
    const { api, tick } = limited({ refused: 2 });
    const before = await attemptsIn(harness.world.alpha);
    const made = async (): Promise<Answer> =>
      await readWith(api, randomBytes(32).toString('base64url'));
    expect((await made()).code).toBe('DELEGATION_NOT_LIVE');
    expect((await made()).code).toBe('DELEGATION_NOT_LIVE');
    const third = await made();
    expect(third.status).toBe(429);
    expect(third.code).toBe('AGENT_QUOTA_EXCEEDED');
    // The third was turned away before its transaction: no attempt row.
    expect(await attemptsIn(harness.world.alpha)).toBe(before + 2);
    tick(61_000);
    expect((await made()).code).toBe('DELEGATION_NOT_LIVE');
  },
);

needsServer(
  'API-2 quota at the door: a live credential is still served once made-up bearers fill the door',
  async () => {
    const { api } = limited({ refused: 2 });
    const live = await issued();
    const made = async (): Promise<Answer> =>
      await readWith(api, randomBytes(32).toString('base64url'));
    await made();
    await made();
    const before = await attemptsIn(harness.world.alpha);
    const past = await Promise.all([made(), made(), made()]);
    expect(codesOf(past)).toEqual(Array.from({ length: 3 }, () => 'AGENT_QUOTA_EXCEEDED'));
    // Past the cap a made-up bearer writes no attempt row.
    expect(await attemptsIn(harness.world.alpha)).toBe(before);
    expect((await readWith(api, live.secret)).code).toBe('ok');
  },
);

needsServer(
  'API-2 quota at the door: a cold burst of made-up bearers writes at most the door’s count of attempt rows, and a live credential in it is served',
  async () => {
    const { api } = limited({ refused: 2 });
    const live = await issued();
    const before = await attemptsIn(harness.world.alpha);
    const made = async (): Promise<Answer> =>
      await readWith(api, randomBytes(32).toString('base64url'));
    // Every bearer knocks before any lookup finishes.
    const burst = await Promise.all([
      ...Array.from({ length: 12 }, made),
      readWith(api, live.secret),
      ...Array.from({ length: 12 }, made),
    ]);
    expect(burst[12]?.code, 'the live credential is served').toBe('ok');
    const codes = codesOf(burst.filter((_, index) => index !== 12));
    expect(codes.filter((code) => code === 'DELEGATION_NOT_LIVE')).toHaveLength(2);
    expect(codes.filter((code) => code === 'AGENT_QUOTA_EXCEEDED')).toHaveLength(22);
    expect(await attemptsIn(harness.world.alpha)).toBe(before + 2);
  },
);

/** The world's pool, keeping each business transaction's statements. */
function counted(): { database: Database; opened: () => readonly (readonly string[])[] } {
  const opened: string[][] = [];
  const app = harness.world.db.app;
  const database = new Proxy(app, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== 'withBusiness' || typeof value !== 'function') return value;
      return async (businessId: string, run: (tx: TenantQuery) => Promise<unknown>) => {
        const sent: string[] = [];
        opened.push(sent);
        return await (value as Database['withBusiness']).call(target, businessId, async (tx) => {
          const query: TenantQuery['query'] = async (text, parameters) => {
            sent.push(text);
            return await tx.query(text, parameters);
          };
          return await run({ businessId: tx.businessId, query });
        });
      };
    },
  });
  return { database, opened: () => opened };
}

/** The API as one server socket reaches it: behind the local proxy, every caller is 127.0.0.1. */
const proxied = (api: Api): Api =>
  ({
    fetch: async (request: Request) =>
      await api.fetch(request, { incoming: { socket: { remoteAddress: '127.0.0.1' } } }),
  }) as unknown as Api;

const madeUp = (): string => randomBytes(32).toString('base64url');

needsServer(
  'API-2 quota at the door: past a full door a made-up bearer costs one read, takes no lock and writes nothing',
  async () => {
    const { database, opened } = counted();
    const { api } = limited({ refused: 2 }, database);
    const again = madeUp();
    expect((await readWith(api, again)).code).toBe('DELEGATION_NOT_LIVE');
    expect((await readWith(api, madeUp())).code).toBe('DELEGATION_NOT_LIVE');
    const rows = await attemptsIn(harness.world.alpha);
    const pastTheDoor = async (secret: string): Promise<void> => {
      const before = opened().length;
      expect((await readWith(api, secret)).code).toBe('AGENT_QUOTA_EXCEEDED');
      const sent = opened().slice(before);
      expect(sent.length, 'one lookup at most').toBeLessThanOrEqual(1);
      expect(sent.flat().filter((text) => !/^\s*select\b/iu.test(text))).toEqual([]);
      expect(sent.flat().join('\n')).not.toMatch(/\bfor\s+(share|update)\b/iu);
    };
    await pastTheDoor(again);
    await pastTheDoor(madeUp());
    expect(await attemptsIn(harness.world.alpha), 'no attempt row').toBe(rows);
  },
);

needsServer(
  'API-2 quota at the door: a credential never served in this process is served while made-up bearers from the same address fill the door',
  async () => {
    const { api } = limited({ refused: 2 });
    const flood = proxied(api);
    await readWith(flood, madeUp());
    await readWith(flood, madeUp());
    await Promise.all(Array.from({ length: 4 }, async () => await readWith(flood, madeUp())));
    const fresh = await issued();
    expect((await readWith(flood, fresh.secret)).code).toBe('ok');
  },
);

needsServer(
  'API-2 quota at the door: a credential made live again inside the window is served',
  async () => {
    const { api } = limited({ refused: 2 });
    const credential = await issued();
    await readWith(api, madeUp());
    await readWith(api, madeUp());
    await agentActive(credential.id, false);
    try {
      expect((await readWith(api, credential.secret)).code).toBe('AGENT_QUOTA_EXCEEDED');
    } finally {
      await agentActive(credential.id, true);
    }
    expect((await readWith(api, credential.secret)).code).toBe('ok');
  },
);

async function agentActive(credentialId: string, active: boolean): Promise<void> {
  await harness.world.db.admin.execute(
    `update public.actors set active = $2, deactivated_at = case when $2 then null else now() end
      where id = (select agent_actor_id from public.agent_credentials where id = $1)`,
    [credentialId, active],
  );
}

async function attemptsIn(businessId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.authentication_attempts where business_id = $1',
    [businessId],
  );
  return Number(rows[0]?.n ?? '-1');
}

needsServer(
  'API-2 door: the live-credential lookup is served by an index on business and hash',
  async () => {
    const credential = await issued();
    const plan = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      // The table is small, so the planner is told not to scan it whole.
      await tx.query("select set_config('enable_seqscan', 'off', true)");
      const rows = await tx.query<{ 'QUERY PLAN': string }>(
        `explain select c.id from public.agent_credentials c
          where c.business_id = $1 and c.credential_hash = encode(sha256($2::bytea), 'hex')`,
        [harness.world.alpha, credential.secret],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('agent_credentials_door');
    expect(plan).toMatch(/Index Cond: .*credential_hash/u);
  },
);
