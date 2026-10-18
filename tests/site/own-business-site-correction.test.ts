// SPDX-License-Identifier: AGPL-3.0-only
//
// R6, part 1 (#1688): a business's own site is bound to the business itself,
// not to a party. A task with no client requests a correction only on a page of
// its own business's site, and a client's task only on its client's site. The
// correction on the business's own site carries no party, so only a
// business-wide grant reaches it. No client is the business: the storage
// refuses a client or a page with the business's identity as its party, and a
// grant scoped to a party that names the business reaches nothing.
//
// Each test binds the sites it needs itself, through `ownSite`, which answers
// the store's refusal rather than throwing, so every control meets its own
// assertion whatever the store does.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { REV, c80World, type C80World } from './c80-world.ts';
import { held, seenWaiting } from './party-site-races.ts';
import { B_PAGE, PAGE } from './c80-sites.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { bindPartySite, readPartySite } from '../../packages/core-records/src/site/party-sites.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Own-business site: DATABASE_URL is unset, so nothing ran.');

const OWN_FILE = 'src/pages/our-about.md';

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('ownbiz');
});

/** Each business's own site keeps one repository and project: a business has one own site. */
const siteNames = new Map<string, string>();

/**
 * Bind a fresh about page on `business`'s own site (no party), binding the site
 * on first use: the page's address, and the store's answer, never thrown.
 */
async function ownSite(
  business: string,
  actorId: string,
): Promise<{ page: string; bound: unknown }> {
  const name = siteNames.get(business) ?? randomUUID().slice(0, 8);
  siteNames.set(business, name);
  const page = `https://own-${name}.example/${randomUUID().slice(0, 8)}/about`;
  const bound = await w.world.db.app
    .withBusiness(
      business,
      async (tx) =>
        await bindPartySite(
          tx,
          {
            partyId: null,
            repository: `own/site-${name}`,
            defaultBranch: 'main',
            project: `prj_own_${name}`,
            pages: [{ pageUrl: page, path: OWN_FILE }],
          },
          actorId,
        ),
    )
    .catch(String);
  return { page, bound };
}

/** A task of alpha's that `ava` starts and nobody puts under a client. */
async function internalTask(): Promise<string> {
  const created = await w.as(w.ava, {
    command: 'task.create',
    fields: { title: 'Our about page' },
  });
  if (isCommandRefusal(created)) throw new Error(`task.create refused ${created.code}`);
  return String(created.recordId);
}

/** The one-word request on `page`, under `taskId`: the server finds the page on the task's site. */
const ownRequest = (
  taskId: string,
  page: string,
  overrides: Readonly<Record<string, unknown>> = {},
) => ({ taskId, page, ...overrides });

const storedOn = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where task_id = $1',
        [taskId],
      )
    )[0]?.n,
  );

describe.skipIf(serverUrl === undefined)('the operands this suite sends', () => {
  it('reaches the own site with the operands this suite sends', async () => {
    const { page, bound } = await ownSite(w.world.business, w.admin.actorId);
    expect(bound).toEqual({ ok: true });
    const taskId = await internalTask();
    expect(
      codeOf(
        await w.asRaw(w.ava, {
          command: 'live_correction.request',
          taskId,
          page,
          word: 'friendly',
          replacement: 'welcoming',
        }),
      ),
    ).toBe('not-a-refusal');
    expect(codeOf(await w.request(w.ava, ownRequest(taskId, page)))).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)("a request on the business's own site", () => {
  it('stores an internal task’s request with its base revision and version, and calls no model', async () => {
    const { page } = await ownSite(w.world.business, w.admin.actorId);
    const taskId = await internalTask();
    const calls = async () =>
      (
        await w.world.db.admin.execute<{ readonly n: string }>(
          'select count(*)::text as n from public.model_calls where business_id = $1',
          [w.world.business],
        )
      )[0]?.n;
    const callsBefore = await calls();
    const stored = await w.request(w.ava, ownRequest(taskId, page));
    expect(codeOf(stored)).toBe('not-a-refusal');
    const [row] = await w.world.db.admin.execute<Record<string, unknown>>(
      `select party_id, base_revision, version_id::text, version_digest, state
         from public.live_corrections where id = $1`,
      [detailOf(stored)['correctionId']],
    );
    expect(row).toMatchObject({ party_id: null, base_revision: REV, state: 'requested' });
    expect(row?.['version_id']).toBe(detailOf(stored)['versionId']);
    expect(row?.['version_digest']).toBe(detailOf(stored)['versionDigest']);
    expect(await calls()).toBe(callsBefore);
  });

  it("reads the business's own site through the same binding, never another business's", async () => {
    const theirs = await ownSite(w.beta, w.eve.actorId);
    const ours = await ownSite(w.world.business, w.admin.actorId);
    const read = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await readPartySite(tx, null),
    );
    expect(read?.partyId).toBeNull();
    expect(read?.pages.map((p) => p.pageUrl)).toContain(ours.page);
    expect(read?.pages.map((p) => p.pageUrl)).not.toContain(theirs.page);
  });

  it("refuses another business's own page from this business's task, storing nothing", async () => {
    await ownSite(w.world.business, w.admin.actorId);
    const theirs = await ownSite(w.beta, w.eve.actorId);
    const taskId = await internalTask();
    const crossed = await w.request(w.ava, ownRequest(taskId, theirs.page));
    expect(codeOf(crossed)).toBe('NOT_FOUND');
    expect(await storedOn(taskId)).toBe(0);
    for (const foreign of [theirs.page, w.beta]) {
      expect(JSON.stringify(crossed)).not.toContain(foreign);
    }
  });
});

describe.skipIf(serverUrl === undefined)('a task and a site that do not belong together', () => {
  it("refuses a client's task on the business's own page, and reads no party from the caller", async () => {
    const { page } = await ownSite(w.world.business, w.admin.actorId);
    const before = await storedOn(w.taskA);
    const asked = await w.request(w.ava, ownRequest(w.taskA, page));
    const named = await w.request(w.ava, ownRequest(w.taskA, page, { partyId: null }));
    expect(codeOf(asked)).toBe('NOT_FOUND');
    expect(codeOf(named)).toBe('COMMAND_BODY_INVALID');
    expect(await storedOn(w.taskA)).toBe(before);
  });

  it("refuses a task with no client on a client's page", async () => {
    await ownSite(w.world.business, w.admin.actorId);
    const taskId = await internalTask();
    const onA = await w.request(w.ava, ownRequest(taskId, PAGE));
    const onB = await w.request(w.ava, ownRequest(taskId, B_PAGE));
    expect(codeOf(onA)).toBe('NOT_FOUND');
    expect(codeOf(onB)).toBe('NOT_FOUND');
    expect(await storedOn(taskId)).toBe(0);
  });

  it('sees a client set on the task during the request’s lock wait, and stores nothing', async () => {
    const { page } = await ownSite(w.world.business, w.admin.actorId);
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
    const request = w.request(w.ava, ownRequest(taskId, page));
    const waited = await seenWaiting(w, /insert into public\.live_corrections/u);
    setting.release();
    await setting.done;
    expect(codeOf(await request)).toBe('NOT_FOUND');
    expect(waited).toBe(true);
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

  it("refuses a page bound with the business's identity as its party", async () => {
    await ownSite(w.world.business, w.admin.actorId);
    await expect(
      w.world.db.admin.execute(
        `insert into public.party_site_pages (business_id, party_id, page_url, path)
         values ($1, $1, $2, $3)`,
        [w.world.business, `https://us-${randomUUID().slice(0, 6)}.example/`, OWN_FILE],
      ),
    ).rejects.toThrow(/party_site_pages_not_the_business/u);
  });
});

describe.skipIf(serverUrl === undefined)('a grant scoped to a party', () => {
  it("gives a grant scoped to a party naming the business nothing on the business's own site", async () => {
    const { page } = await ownSite(w.world.business, w.admin.actorId);
    const taskId = await internalTask();
    // Dee holds run and gate only at party B; this grant names the business as a party.
    await w.world.db.admin.execute(
      `insert into public.grants (business_id, id, subject_kind, subject_id, collection, action,
                                  scope_kind, scope_id, granted_by_actor_id)
       select g.business_id, gen_random_uuid(), g.subject_kind, g.subject_id, g.collection,
              g.action, 'party', $1, g.granted_by_actor_id
         from public.grants g
        where g.business_id = $1 and g.subject_kind = 'person' and g.subject_id = $2
          and g.collection in ('run', 'gate')`,
      [w.world.business, w.dee.personId],
    );
    const theirs = await w.request(w.dee, ownRequest(taskId, page));
    const ours = await w.request(w.ava, ownRequest(taskId, page));
    expect(isCommandRefusal(theirs)).toBe(true);
    expect(codeOf(ours)).toBe('not-a-refusal');
    const decided = await w.as(w.dee, {
      command: 'live_correction.decide',
      correctionId: detailOf(ours)['correctionId'],
      versionId: detailOf(ours)['versionId'],
      decision: 'approve',
    });
    expect(codeOf(decided)).toBe('SCOPE_NOT_GRANTED');
    const [row] = await w.world.db.admin.execute<{ readonly state: string }>(
      'select state from public.live_corrections where task_id = $1',
      [taskId],
    );
    expect(row?.state).toBe('requested');
  });
});
