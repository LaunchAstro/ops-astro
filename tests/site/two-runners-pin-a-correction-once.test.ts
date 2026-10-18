// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, races, each on separate connections: two pins of one correction
// write once; a pin against a cancel either pins first or finds it gone; a
// stamp against a supersede never vouches for a superseded version; and the
// approval's 60 s bound is read after its lock wait, not before (v3 gap 2,
// proof c): a stamp 57 s old when a second connection holds the row for 4 s
// is refused `VERSION_UNVERIFIED`.

import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  pinLocated,
  stampVerified,
  supersede,
  type ConfiguredSite,
} from '../../packages/core-records/src/site/locate.ts';
import { c80World, pinFromBefore, type C80World } from './c80-world.ts';
import {
  freshClient,
  held,
  inAlpha,
  insertOn,
  seenWaiting,
  type FreshClient,
} from './party-site-races.ts';
import { TEST_PIN } from './located.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Pin races: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('pinrace');
}, 120_000);

const configured = (client: FreshClient): ConfiguredSite => ({
  holder: client.partyId,
  repository: client.site.repository,
  defaultBranch: client.site.defaultBranch,
  project: client.site.project,
  pages: client.pages,
});

async function locatingOn(client: FreshClient): Promise<string> {
  const stored = await inAlpha(w, insertOn(w, client, client.pages[0]));
  if ('code' in stored) throw new Error(`request refused ${stored.code}`);
  return stored.id;
}

const pin = (id: string) => ({ id, versionId: crypto.randomUUID(), ...TEST_PIN });

const rowOf = async (id: string) =>
  (
    await w.world.db.admin.execute<{
      readonly state: string;
      readonly version_id: string | null;
      readonly verified_at: Date | null;
      readonly revision: number;
    }>(
      'select state, version_id, verified_at, revision from public.live_corrections where id = $1',
      [id],
    )
  )[0];

describe.skipIf(serverUrl === undefined)('two runners pin a correction once', () => {
  it('writes the pin once when two runners pin together', async () => {
    const client = await freshClient(w);
    const id = await locatingOn(client);
    const first = pin(id);
    const one = held(w, async (tx) => await pinLocated(tx, configured(client), first));
    expect(await one.ready).toBe('pinned');
    const two = inAlpha(w, async (tx) => await pinLocated(tx, configured(client), pin(id)));
    const waited = await seenWaiting(w, /update public\.live_corrections/u).finally(() =>
      one.release(),
    );
    expect(waited).toBe(true);
    await one.done;
    expect(await two).toBe('gone');
    expect((await rowOf(id))?.version_id).toBe(first.versionId);
  });
});

describe.skipIf(serverUrl === undefined)('two runners pin a correction once', () => {
  it('pins first or finds the correction cancelled, never both', async () => {
    const client = await freshClient(w);
    const id = await locatingOn(client);
    const cancel = held(w, async (tx) => {
      await tx.query(`update public.live_corrections set state = 'cancelled' where id = $1`, [id]);
    });
    await cancel.ready;
    const pinning = inAlpha(w, async (tx) => await pinLocated(tx, configured(client), pin(id)));
    await seenWaiting(w, /update public\.live_corrections/u).finally(() => cancel.release());
    await cancel.done;
    expect(await pinning).toBe('gone');
    expect(await rowOf(id)).toMatchObject({ state: 'cancelled', version_id: null });
  });
});

describe.skipIf(serverUrl === undefined)('two runners pin a correction once', () => {
  it('never stamps a version a racing check superseded', async () => {
    const client = await freshClient(w);
    const id = await locatingOn(client);
    expect(await inAlpha(w, async (tx) => await pinLocated(tx, configured(client), pin(id)))).toBe(
      'pinned',
    );
    const stamped = (await rowOf(id))?.verified_at;
    const drift = `sha256:${'ef'.repeat(32)}`;
    const superseding = held(w, async (tx) => await supersede(tx, id, drift));
    expect(await superseding.ready).toBe(true);
    const stamping = inAlpha(
      w,
      async (tx) => await stampVerified(tx, configured(client), id, TEST_PIN.preImageDigest),
    );
    await seenWaiting(w, /update public\.live_corrections/u).finally(() => superseding.release());
    await superseding.done;
    expect(await stamping).toBe(false);
    expect(await rowOf(id)).toMatchObject({ state: 'superseded', verified_at: stamped });
  });
});

describe.skipIf(serverUrl === undefined)('two runners pin a correction once', () => {
  it('reads the 60 s bound after the lock wait, refusing a check that aged while waiting', async () => {
    const asked = await w.asRaw(w.ava, {
      command: 'live_correction.request',
      taskId: w.taskA,
      page: 'About',
      word: 'friendly',
      replacement: 'welcoming',
    });
    if (isCommandRefusal(asked)) throw new Error(`request refused ${asked.code}`);
    const id = String(asked.detail['correctionId']);
    const { versionId } = await pinFromBefore(w.world.db.admin, id);
    await w.world.db.admin.execute(
      `with replica as (select set_config('session_replication_role', 'replica', true))
       update public.live_corrections set verified_at = clock_timestamp() - interval '57 seconds'
         from replica where id = $1`,
      [id],
    );
    const before = await rowOf(id);
    const holding = held(w, async (tx) => {
      await tx.query('select 1 from public.live_corrections where id = $1 for update', [id]);
    });
    await holding.ready;
    const deciding = w.as(w.ben, {
      command: 'live_correction.decide',
      correctionId: id,
      versionId,
      decision: 'approve',
    });
    const waited = await seenWaiting(w, /from public\.live_corrections/u);
    await sleep(4_000);
    holding.release();
    await holding.done;
    expect(waited).toBe(true);
    expect(codeOf(await deciding)).toBe('VERSION_UNVERIFIED');
    expect(await rowOf(id)).toStrictEqual(before);
  });
});
