// SPDX-License-Identifier: AGPL-3.0-only
//
// R6, part 1 (#1688): a business's own site is bound to the business itself,
// not to a party. A task with no client requests a correction only on a page of
// its own business's site, and a client's task only on its client's site. The
// correction on the business's own site carries no party, so only a
// business-wide grant reaches it. No client is the business: the storage
// refuses a client with the business's identity, and a grant scoped to a party
// that names the business reaches nothing.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { held, waitSeen } from './party-site-races.ts';
import { B_FILE, B_PAGE, PAGE, ABOUT } from './c80-sites.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { bindPartySite, readPartySite } from '../../packages/core-records/src/site/party-sites.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Own-business site: DATABASE_URL is unset, so nothing ran.');

const OWN_FILE = 'src/pages/our-about.md';

let w: C80World;
let ownPage: string;
let betaOwnPage: string;

/** A task of alpha's that `ava` starts and nobody puts under a client. */
async function internalTask(): Promise<string> {
  const created = await w.as(w.ava, {
    command: 'task.create',
    fields: { title: 'Our about page' },
  });
  if (isCommandRefusal(created)) throw new Error(`task.create refused ${created.code}`);
  return String(created.recordId);
}

/** The one-word request on the business's own about page, under `taskId`. */
const ownRequest = (taskId: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  partyId: null,
  taskId,
  pageUrl: ownPage,
  path: OWN_FILE,
  ...overrides,
});

const storedOn = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where task_id = $1',
        [taskId],
      )
    )[0]?.n,
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('ownbiz');
  const own = randomUUID().slice(0, 8);
  ownPage = `https://own-${own}.example/about`;
  betaOwnPage = `https://beta-own-${own}.example/about`;
  const ours = await w.world.db.app.withBusiness(w.world.business, async (tx) =>
    bindPartySite(
      tx,
      {
        partyId: null,
        repository: `own/site-${own}`,
        defaultBranch: 'main',
        project: `prj_own_${own}`,
        pages: [{ pageUrl: ownPage, path: OWN_FILE }],
      },
      w.admin.actorId,
    ),
  );
  const theirs = await w.world.db.app.withBusiness(w.beta, async (tx) =>
    bindPartySite(
      tx,
      {
        partyId: null,
        repository: `beta-own/site-${own}`,
        defaultBranch: 'main',
        project: `prj_beta_own_${own}`,
        pages: [{ pageUrl: betaOwnPage, path: OWN_FILE }],
      },
      w.eve.actorId,
    ),
  );
  expect([ours, theirs]).toEqual([{ ok: true }, { ok: true }]);
});

describe.skipIf(serverUrl === undefined)("a request on the business's own site", () => {
  it('stores an internal task’s request with its base revision and version, and calls no model', async () => {
    const taskId = await internalTask();
    const calls = async () =>
      (
        await w.world.db.admin.execute<{ readonly n: string }>(
          'select count(*)::text as n from public.model_calls where business_id = $1',
          [w.world.business],
        )
      )[0]?.n;
    const callsBefore = await calls();
    const stored = await w.request(w.ava, ownRequest(taskId));
    expect(codeOf(stored)).toBe('not-a-refusal');
    const [row] = await w.world.db.admin.execute<Record<string, unknown>>(
      `select party_id, base_revision, version_id::text, version_digest, state
         from public.live_corrections where id = $1`,
      [detailOf(stored)['correctionId']],
    );
    expect(row).toMatchObject({ party_id: null, base_revision: 'rev-1', state: 'requested' });
    expect(row?.['version_id']).toBe(detailOf(stored)['versionId']);
    expect(row?.['version_digest']).toBe(detailOf(stored)['versionDigest']);
    expect(await calls()).toBe(callsBefore);
  });

  it("reads the business's own site through the same binding, never another business's", async () => {
    const ours = await w.world.db.app.withBusiness(w.world.business, async (tx) =>
      readPartySite(tx, null),
    );
    expect(ours?.pages).toEqual([{ pageUrl: ownPage, path: OWN_FILE }]);
    expect(ours?.partyId).toBeNull();
  });

  it("refuses another business's own page from this business's task, storing nothing", async () => {
    const taskId = await internalTask();
    const crossed = await w.request(w.ava, ownRequest(taskId, { pageUrl: betaOwnPage }));
    expect(codeOf(crossed)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(await storedOn(taskId)).toBe(0);
    for (const foreign of [betaOwnPage, 'beta-own', w.beta]) {
      expect(JSON.stringify(crossed)).not.toContain(foreign);
    }
  });
});

describe.skipIf(serverUrl === undefined)('a task and a site that do not belong together', () => {
  it("refuses a client's task on the business's own page, either way the party is named", async () => {
    const before = await storedOn(w.taskA);
    const asOwn = await w.request(w.ava, ownRequest(w.taskA));
    const asClient = await w.request(w.ava, ownRequest(w.taskA, { partyId: w.partyA }));
    expect(codeOf(asOwn)).toBe('CORRECTION_PARTY_MISMATCH');
    expect(codeOf(asClient)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(await storedOn(w.taskA)).toBe(before);
  });

  it("refuses a task with no client on a client's page, either way the party is named", async () => {
    const taskId = await internalTask();
    const asOwn = await w.request(w.ava, ownRequest(taskId, { pageUrl: PAGE, path: ABOUT }));
    const asClient = await w.request(w.ava, {
      ...ownRequest(taskId, { pageUrl: B_PAGE, path: B_FILE }),
      partyId: w.partyB,
    });
    expect(codeOf(asOwn)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(codeOf(asClient)).toBe('CORRECTION_PARTY_MISMATCH');
    expect(await storedOn(taskId)).toBe(0);
  });

  it('sees a client set on the task during the request’s lock wait, and stores nothing', async () => {
    const taskId = await internalTask();
    // The client link is the task's `client` field, projected into its slot by the write.
    const setting = held(w, async (tx) => {
      await tx.query(
        `update public.records set data = jsonb_set(data, '{client}', to_jsonb($2::text))
          where business_id = $1 and id = $3`,
        [tx.businessId, w.partyA, taskId],
      );
    });
    await setting.ready;
    const request = w.request(w.ava, ownRequest(taskId));
    await waitSeen(w, /insert into public\.live_corrections/u);
    setting.release();
    await setting.done;
    expect(codeOf(await request)).toBe('CORRECTION_PARTY_MISMATCH');
    expect(await storedOn(taskId)).toBe(0);
  });
});

describe.skipIf(serverUrl === undefined)('no party is the business', () => {
  it("refuses a client whose identity is the business's", async () => {
    await expect(
      w.world.db.admin.execute(
        `insert into public.clients (business_id, id, name, created_by_actor_id)
         values ($1, $1, 'Us', $2)`,
        [w.world.business, w.admin.actorId],
      ),
    ).rejects.toThrow(/clients_not_the_business/u);
  });

  it("refuses a task put under the business's own identity as its client", async () => {
    const created = await w.as(w.ava, { command: 'task.create', fields: { title: 'Us' } });
    if (isCommandRefusal(created)) throw new Error(`task.create refused ${created.code}`);
    const set = await w.as(w.admin, {
      command: 'task.set_party',
      recordId: created.recordId,
      expectedRevision: created.revision,
      fields: { client: w.world.business },
    });
    expect(isCommandRefusal(set)).toBe(true);
  });

  it("gives a grant scoped to a party naming the business nothing on the business's own site", async () => {
    const taskId = await internalTask();
    // Dee holds run and gate only at party B; this grant names the business as a party.
    await w.world.db.admin.execute(
      `insert into public.grants (business_id, id, subject_kind, subject_id, collection, action,
                                  scope_kind, scope_id, granted_by_actor_id)
       select g.business_id, gen_random_uuid(), g.subject_kind, g.subject_id, g.collection,
              g.action, 'party', $1, g.granted_by_actor_id
         from public.grants g
        where g.business_id = $1 and g.subject_kind = 'person' and g.subject_id = $2
          and g.collection = 'run' and g.action = 'write'`,
      [w.world.business, w.dee.personId],
    );
    const asked = await w.request(w.dee, ownRequest(taskId));
    expect(isCommandRefusal(asked)).toBe(true);
    expect(await storedOn(taskId)).toBe(0);
  });
});
