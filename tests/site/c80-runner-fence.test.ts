// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 capture through the fence: the runner's capture port is the C18-1 fence
// itself (the catalogue pool, a resolver and the pinned transport), never a
// function a caller hands in, and the page the correction stored is checked
// against the catalogue before anything is read, sent or fetched. The stored
// `pageUrl` is as the requester sent it, so a page outside the catalogue must
// stop the run: a publish nobody can observe is an effect nobody can verify.
// Every provider here is a double: nothing reaches a live system.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { PAGE, c80World, type C80World } from './c80-world.ts';
import { PUBLIC_ADDRESS, doubles } from './c80-runner-doubles.ts';
import {
  runLivePublish,
  runLiveRevert,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 runner fence: DATABASE_URL is unset, so nothing ran.');

const ELSEWHERE = 'https://elsewhere.example/about/';
const EMPTY_POOL = { agencyPages: [], otherPages: [], closedPoolReviews: [] };

let w: C80World;
let lease: { leaseId: string; fence: number; taskId: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80fence');
  await w.setApprover(w.ben.personId);
  const picked = await w.world.pickUp(w.cal, 'publish the About correction');
  const rows = await w.world.db.admin.execute<{ readonly id: string; readonly fence: string }>(
    `select id, fence::text as fence from public.leases where task_id = $1 and state = 'live'`,
    [picked.taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no live lease after pickup');
  lease = { leaseId: row.id, fence: Number(row.fence), taskId: picked.taskId };
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** An approved correction whose stored page is `pageUrl`. */
async function approved(pageUrl = PAGE): Promise<string> {
  const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId, pageUrl }));
  const id = String(detail['correctionId']);
  expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  return id;
}

const at = (correctionId: string) => ({
  business: w.world.business,
  correctionId,
  leaseId: lease.leaseId,
  fence: lease.fence,
});
const publish = async (id: string, ports: RunnerPorts) =>
  await runLivePublish(w.world.db.app, at(id), ports);
const revert = async (id: string, ports: RunnerPorts) =>
  await runLiveRevert(w.world.db.app, at(id), ports);

type Doubles = ReturnType<typeof doubles>;
/** Nothing read, sent, resolved or fetched. */
const untouched = (ports: Doubles) => [
  ports.seen.sourceReads,
  ports.seen.dispatched.length,
  ports.seen.resolved.length,
  ports.seen.captured.length,
  ports.seen.reverted,
];

describe.skipIf(serverUrl === undefined)('C80 capture through the fence', () => {
  it('refuses a stored page outside the catalogue before anything is read, sent or fetched', async () => {
    const id = await approved(ELSEWHERE);
    const ports = doubles();
    expect(await publish(id, ports)).toEqual({
      kind: 'refused',
      code: 'CAPTURE_HOST_NOT_CATALOGUED',
      waitsOn: 'person',
    });
    expect(untouched(ports)).toEqual([0, 0, 0, 0, 0]);
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['approved', 0]);
    expect(ports.seen.raised).toEqual(['CAPTURE_HOST_NOT_CATALOGUED']);
    expect(ports.seen.fenceRefusals).toEqual([
      { code: 'CAPTURE_HOST_NOT_CATALOGUED', hop: 0, origin: 'https://elsewhere.example' },
    ]);
  });

  it.each([
    ['without its trailing slash', 'https://agency.example/about'],
    ['with a query', `${PAGE}?page=2`],
    ['with a fragment', `${PAGE}#team`],
    ['with the host in capitals', 'https://AGENCY.example/about/'],
    ['with a port', 'https://agency.example:443/about/'],
    ['with a trailing dot on the host', 'https://agency.example./about/'],
    ['over plain http', 'http://agency.example/about/'],
    ['with userinfo', `https://someone${'@'}agency.example/about/`],
    ['with an encoded path', 'https://agency.example/%61bout/'],
    ['not an address at all', 'about page'],
  ])('refuses the catalogued page spelt %s, sending nothing', async (_, spelling) => {
    const id = await approved(spelling);
    const ports = doubles();
    expect(await publish(id, ports)).toMatchObject({
      kind: 'refused',
      code: 'CAPTURE_HOST_NOT_CATALOGUED',
    });
    expect(untouched(ports)).toEqual([0, 0, 0, 0, 0]);
    expect(await w.stateOf(id)).toBe('approved');
    // What the fence recorded carries the origin only: no path, query or fragment.
    expect(JSON.stringify(ports.seen.fenceRefusals)).not.toMatch(/about|page=2|team/u);
  });
});

describe.skipIf(serverUrl === undefined)('C80 capture through the fence', () => {
  it('answers an unapproved correction with its approval first, raising nothing', async () => {
    const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId, pageUrl: ELSEWHERE }));
    const ports = doubles();
    expect(await publish(String(detail['correctionId']), ports)).toEqual({
      kind: 'refused',
      code: 'APPROVAL_MISSING',
    });
    expect(untouched(ports)).toEqual([0, 0, 0, 0, 0]);
    expect([ports.seen.raised, ports.seen.fenceRefusals]).toEqual([[], []]);
  });

  it('refuses a page catalogued among others while the pool reviews are open', async () => {
    const id = await approved(ELSEWHERE);
    const pool = {
      agencyPages: [],
      otherPages: [ELSEWHERE],
      closedPoolReviews: ['r1', 'r2', 'r2'],
    };
    const ports = doubles({}, { pool });
    expect(await publish(id, ports)).toMatchObject({
      kind: 'refused',
      code: 'CAPTURE_POOL_REVIEWS_OPEN',
    });
    expect(untouched(ports)).toEqual([0, 0, 0, 0, 0]);
    expect(await w.stateOf(id)).toBe('approved');
  });

  it('captures the catalogued page through the fence, at the address it resolved', async () => {
    const id = await approved();
    const seenBy: { address: string; family: number; method: string | undefined }[] = [];
    const site = doubles();
    const fenced = doubles(
      {},
      {
        transport: async (request) => {
          seenBy.push({ address: request.address, family: request.family, method: request.method });
          return await site.capture.transport(request);
        },
      },
    );
    expect(await publish(id, fenced)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(site.seen.captured).toEqual([PAGE]);
    expect(seenBy).toEqual([{ address: PUBLIC_ADDRESS, family: 4, method: 'GET' }]);
    expect(fenced.seen.resolved).toEqual(['agency.example']);
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 capture through the fence, after the dispatch',
  () => {
    it('never fetches a page whose name answers a private address; the publish stays accepted', async () => {
      const id = await approved();
      const ports = doubles({}, { resolve: () => Promise.resolve([PUBLIC_ADDRESS, '10.0.0.5']) });
      expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect([ports.seen.dispatched.length, ports.seen.captured.length]).toEqual([1, 0]);
      expect(ports.seen.fenceRefusals).toEqual([
        { code: 'CAPTURE_ADDRESS_DENIED', hop: 0, origin: 'https://agency.example' },
      ]);
      const rows = await w.world.db.admin.execute<{ readonly r: string }>(
        `select observations -> 'refusals_raised' ->> 'observed' as r
         from public.live_correction_receipts where correction_id = $1`,
        [id],
      );
      expect(rows.map((row) => row.r)).toEqual(['CAPTURE_ADDRESS_DENIED']);
    });

    it('does not observe an accepted publish again once its page has left the catalogue', async () => {
      const id = await approved();
      const first = doubles({
        readDeployment: () =>
          Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served: false } }),
      });
      expect(await publish(id, first)).toMatchObject({ kind: 'recorded', state: 'accepted' });
      const again = doubles({}, { pool: EMPTY_POOL });
      expect(await publish(id, again)).toMatchObject({
        kind: 'refused',
        code: 'CAPTURE_HOST_NOT_CATALOGUED',
      });
      expect(untouched(again)).toEqual([0, 0, 0, 0, 0]);
      expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['accepted', 1]);
    });

    it('does not revert a live page that has left the catalogue, sending nothing', async () => {
      const id = await approved();
      expect(await publish(id, doubles())).toMatchObject({ kind: 'recorded', state: 'live' });
      const later = doubles({}, { pool: EMPTY_POOL });
      expect(await revert(id, later)).toMatchObject({
        kind: 'refused',
        code: 'CAPTURE_HOST_NOT_CATALOGUED',
      });
      expect(untouched(later)).toEqual([0, 0, 0, 0, 0]);
      expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['live', 1]);
    });
  },
);
