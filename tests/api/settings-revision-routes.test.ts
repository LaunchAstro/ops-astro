// SPDX-License-Identifier: AGPL-3.0-only
//
// The settings revision, reached the way a caller reaches it: over HTTP.
//
// The command-path cases beside this one call the envelope directly, which
// proves the handler and not the route. `expectedRevision` arrives in a JSON
// body the boundary spreads into the request, so a wiring that reads it from
// somewhere the boundary does not fill would pass there and fail here — which
// is exactly the gap the two settings commands had while the column existed
// and nothing on the wire could name it.
//
// The composition is `tests/api/fixture.ts`'s, narrowed to what these cases
// need: a real Hono app over a real database, the verifier substituted for the
// signature check only, and every path taken from `pathOf` so a declaration
// that stopped generating a route fails here as a 404 rather than quietly.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { createApi } from '../../apps/api/app.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api settings revision: DATABASE_URL is unset, so nothing below ran.');
}

const BUSINESS_KEY = 'alpha';

interface SettingRow {
  readonly key: string;
  readonly value: number | boolean | string | null;
  readonly revision: number;
}

describe.skipIf(serverUrl === undefined)('the settings revision over HTTP', () => {
  let db: FreshDatabase;
  let alpha: string;
  let mia: Member;
  let api: ReturnType<typeof createApi>;

  const post = async (name: CommandName, body: unknown, who: Member = mia) =>
    await api.fetch(
      new Request(`http://api.test/api/b/${BUSINESS_KEY}${pathOf(name)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${who.presented.subject}`,
        },
        body: JSON.stringify(body),
      }),
    );

  /** Every setting as the read surface serves it, over the same boundary. */
  const settings = async (): Promise<readonly SettingRow[]> => {
    const response = await post('settings.read' as CommandName, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly settings: readonly SettingRow[] };
    return body.settings;
  };

  const bandRow = async (): Promise<SettingRow | undefined> =>
    (await settings()).find((setting) => setting.key === 'four_eyes_threshold');

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l3apirev' });
    alpha = await insertBusiness(db.app, BUSINESS_KEY);
    await installSpine(db.app, alpha);
    await db.app.withBusiness(alpha, async (tx) => {
      await installBusinessSettings(tx);
    });
    mia = await enrol(db.app, alpha, 'mia');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, mia, 'read');
      await grantTo(tx, mia, 'read', { kind: 'business', id: null }, false, 'settings');
      await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'settings');
    });

    api = createApi({
      database: db.app,
      // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
      verify: async (request) => {
        const header = request.header('authorization') ?? '';
        const subject = header.replace(/^Bearer /u, '');
        return subject === '' ? undefined : { provider: 'supabase', subject };
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
      resolveBusiness: async (key) => (key === BUSINESS_KEY ? alpha : undefined),
      executeRead: async (database, businessId, presented, request) =>
        await executeRead(
          database,
          businessId,
          presented,
          request as unknown as Parameters<typeof executeRead>[3],
        ),
    });
  }, 60_000);

  afterAll(async () => await db?.drop());

  it('serves a numeric revision on every settings.read row', async () => {
    const rows = await settings();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.revision).toBe('number');
    }
  });

  it('applies a write carrying no expectedRevision, answering with the new revision', async () => {
    const before = await bandRow();
    const response = await post('settings.set_four_eyes_threshold', {
      operationId: `band-${randomUUID()}`,
      value: 710,
    });
    expect(response.status).toBe(200);
    const handle = (await response.json()) as { readonly revision: number | null };
    expect(handle.revision).toBe((before?.revision ?? 0) + 1);
    expect((await bandRow())?.value).toBe(710);
  });

  it('applies a write naming the revision the read just served', async () => {
    const before = await bandRow();
    const response = await post('settings.set_four_eyes_threshold', {
      operationId: `band-${randomUUID()}`,
      value: 720,
      expectedRevision: before?.revision,
    });
    expect(response.status).toBe(200);
    const handle = (await response.json()) as { readonly revision: number | null };
    expect(handle.revision).toBe((before?.revision ?? 0) + 1);
    expect((await bandRow())?.value).toBe(720);
  });

  it('refuses a stale write 409 VERSION_STALE and leaves the stored value alone', async () => {
    const current = await bandRow();
    const response = await post('settings.set_four_eyes_threshold', {
      operationId: `band-${randomUUID()}`,
      value: 999,
      expectedRevision: (current?.revision ?? 1) - 1,
    });
    expect(response.status).toBe(409);
    const refusal = (await response.json()) as {
      readonly refused: boolean;
      readonly code: string;
      readonly names: readonly string[];
    };
    expect(refusal.refused).toBe(true);
    expect(refusal.code).toBe('VERSION_STALE');
    expect(refusal.names).toContain(`revision=${current?.revision}`);

    const after = await bandRow();
    expect(after?.value).toBe(current?.value);
    expect(after?.revision).toBe(current?.revision);
  });
});
