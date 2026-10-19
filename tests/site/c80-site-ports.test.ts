// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner on its site ports through guarded provider calls. Publish
// advances the default branch from the approved base to the proposal's head,
// which closes the human review request as merged. Bindings refuse other corrections before provider
// calls, captures or reconciliation receipts. Nothing reaches a live system.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AFTER, BEFORE, REV } from './c80-world.ts';
import { HEAD, line } from './c80-site-provider.ts';
import { bound, B_PAGE, B_FILE, OTHER_SEAM } from './c80-site-ports-bound.ts';
import {
  approved,
  publish,
  receipt,
  revert,
  serverUrl,
  useRegisterWorld,
  w,
} from './c80-register-world.ts';

useRegisterWorld();

/** Party A's approved correction copied onto `pageUrl` and `path` by the owner, past the store. */
async function approvedPastTheStore(pageUrl: string, path: string): Promise<string> {
  const own = await approved();
  const id = randomUUID();
  await w.world.db.admin.execute(
    `insert into public.live_corrections
       (business_id, id, party_id, task_id, requested_by_actor_id, requested_by_person_id,
        delegation_id, target_path, word, replacement, page_url, pre_image_digest,
        base_revision, seam, version_id, version_digest, state, decided_by_actor_id,
        decided_by_person_id, decided_at, decided_version_digest, located_at, verified_at)
     select business_id, $2::uuid, party_id, task_id, requested_by_actor_id,
            requested_by_person_id, delegation_id, $4, word, replacement, $3,
            pre_image_digest, base_revision, 'seam-' || $2, gen_random_uuid(), version_digest,
            state, decided_by_actor_id, decided_by_person_id, decided_at,
            decided_version_digest, located_at, verified_at
       from public.live_corrections where id = $1`,
    [own, id, pageUrl, path],
  );
  return id;
}

const SOURCE = 'GET /repos/agency/site/contents/src/pages/about.md?ref=main';
const HEAD_READ = 'GET /repos/agency/site/git/ref/heads/main';
const ADVANCE = 'PATCH /repos/agency/site/git/refs/heads/main';
const advances = (site: Awaited<ReturnType<typeof bound>>['site']) =>
  site.sent.filter((sent) => line(sent) === ADVANCE);
const refusalsOn = async (id: string, step: string): Promise<string[]> =>
  ((await receipt(id, step))['refusals_raised']?.observed ?? '').split(' ');

describe.skipIf(serverUrl === undefined)('C80 runner on the site ports', () => {
  it('publishes the approved proposal live, then reverts it forward', async () => {
    const id = await approved();
    const { site, ports } = await bound(id);
    expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(site.sent.map(line)).toEqual([
      SOURCE,
      HEAD_READ,
      SOURCE,
      SOURCE,
      'GET /repos/agency/site/branches/main/protection',
      HEAD_READ,
      'GET /repos/agency/site/pulls/17',
      ADVANCE,
      HEAD_READ,
      'GET /v6/deployments?projectId=prj_site&sha=c0ffee01&target=production&limit=1',
      'GET /v13/deployments/dpl_merged',
      'GET /v9/projects/prj_site',
      'GET /v4/aliases/agency.example?projectId=prj_site',
      'GET /v13/deployments/dpl_merged',
      'GET /v9/projects/prj_site',
      'GET /v4/aliases/agency.example?projectId=prj_site',
      'GET /repos/agency/site/pulls/17',
    ]);
    expect(site.state.request?.merged).toBe(true);
    expect(site.state.content).toBe(AFTER);
    site.sent.length = 0;
    expect(await revert(id, ports())).toMatchObject({ kind: 'recorded', state: 'reverted' });
    expect(site.sent.map(line)).toEqual([
      SOURCE,
      SOURCE,
      'PUT /repos/agency/site/contents/src/pages/about.md',
      'GET /v6/deployments?projectId=prj_site&sha=c0ffee03&target=production&limit=1',
      'GET /v13/deployments/dpl_reverted',
      'GET /v9/projects/prj_site',
      'GET /v4/aliases/agency.example?projectId=prj_site',
      'GET /v13/deployments/dpl_reverted',
      'GET /v9/projects/prj_site',
      'GET /v4/aliases/agency.example?projectId=prj_site',
    ]);
    expect(site.state.content).toBe(BEFORE);
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 runner on the site ports: what it cannot place',
  () => {
    it('keeps a concurrent default-branch commit when the fast-forward refuses', async () => {
      const id = await approved();
      const concurrent = BEFORE + '<p>Another footer.</p>\n';
      const { site, ports, raised } = await bound(id, {
        wrap: (double) => async (request) => {
          if (request.method === 'PATCH') {
            double.state.content = concurrent;
            double.state.parents['concurrent-commit'] = REV;
            double.state.mainHead = 'concurrent-commit';
          }
          return await double.deps.transport(request);
        },
      });
      // The 422 is read back: the head is neither the proposal's nor the base, so it stays unknown.
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(site.state.content).toBe(concurrent);
      expect(site.state.mainHead).toBe('concurrent-commit');
      expect(site.state.deployments).toEqual({});
      expect(advances(site)).toHaveLength(1);
      expect(site.sent.some((sent) => sent.method === 'PUT')).toBe(false);
      expect(site.state.request?.merged).toBe(false);
      expect(raised).toEqual(['RECONCILE_UNPROVEN']);
      expect(await refusalsOn(id, 'publish')).toContain('PROVIDER_REFUSED');
    });

    it("keeps the fence's refusal of the page for the receipt", async () => {
      const id = await approved();
      const { ports, raised } = await bound(id, { status: 503 });
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect(raised).toEqual(['LIVE_CHECK_UNPLACED']);
      expect(await refusalsOn(id, 'publish')).toContain('CAPTURE_STATUS_REFUSED');
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C80 runner ports run only the correction they were bound to',
  () => {
    it('sends nothing for a binding on another seam', async () => {
      const id = await approved();
      const { site, ports, raised, captured } = await bound(id, { seam: OTHER_SEAM });
      expect(await publish(id, ports())).toEqual({
        kind: 'refused',
        code: 'BINDING_NOT_THIS_CORRECTION',
        waitsOn: 'person',
      });
      expect(site.sent).toEqual([]);
      expect(captured).toEqual([]);
      expect(raised).toEqual(['BINDING_NOT_THIS_CORRECTION']);
      expect(await w.stateOf(id)).toBe('approved');
    });

    it("sends and captures nothing for party A's correction naming party B's page and file", async () => {
      // The request now refuses this crossing, so it is written past the store,
      // as a row stored before the request read a client's site.
      const crossing = await approvedPastTheStore(B_PAGE, B_FILE);
      await expect(bound(crossing)).rejects.toThrow('not bound: PAGE_OUTSIDE_PARTY_SITE');
      // Ports bound to party A's own correction on its own page, run on the crossing one.
      const own = await approved();
      const { site, ports, captured } = await bound(crossing, { boundTo: own });
      expect(await publish(crossing, ports())).toMatchObject({
        kind: 'refused',
        code: 'BINDING_NOT_THIS_CORRECTION',
      });
      expect(site.sent).toEqual([]);
      expect(captured).toEqual([]);
      expect(await w.stateOf(crossing)).toBe('approved');
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C80 runner ports bound for another party run nothing',
  () => {
    it("sends and captures nothing for party A's correction on ports bound for party B", async () => {
      const id = await approved();
      const { site, ports, captured } = await bound(id, { party: () => w.partyB });
      expect(await publish(id, ports())).toMatchObject({
        kind: 'refused',
        code: 'BINDING_NOT_THIS_CORRECTION',
      });
      expect(site.sent).toEqual([]);
      expect(captured).toEqual([]);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C80 publication advances the default branch by the approved commit only',
  () => {
    it('advances nothing once a commit is pushed onto the seam since the proposal', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.defaultExtras['src/pages/contact.md'] = 'approved contact';
      // Another commit on the seam after the proposal: the request now shows it as its head.
      site.state.parents['c0ffee99'] = HEAD;
      if (site.state.request) site.state.request.head = 'c0ffee99';
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(site.state.content).toBe(BEFORE);
      expect(site.state.mainHead).toBe(REV);
      expect(site.state.defaultExtras['src/pages/contact.md']).toBe('approved contact');
      expect(site.sent.filter((sent) => sent.method !== 'GET')).toEqual([]);
      expect(site.state.request?.merged).toBe(false);
      expect(raised).toEqual(['REQUEST_HEAD_MOVED']);
    });

    it('advances the default branch after the request is retargeted', async () => {
      const id = await approved();
      const { site, ports } = await bound(id);
      if (site.state.request) site.state.request.base = 'staging';
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
      expect(site.state.content).toBe(AFTER);
      expect(site.state.stagingContent).toBe(BEFORE);
      expect(site.state.request?.merged).toBe(false);
      expect(advances(site)).toHaveLength(1);
      expect(site.sent.some((sent) => sent.method === 'PUT')).toBe(false);
      expect((await receipt(id, 'publish'))['published_revision']).toEqual({
        observed: HEAD,
      });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C80 binding refusal before unknown reconciliation',
  () => {
    it('adds no receipts or reconciliation task for an unknown publish on another binding', async () => {
      const id = await approved();
      const own = await bound(id);
      await expect(
        publish(id, {
          ...own.ports(),
          publish: () => Promise.reject(new Error('worker lost before effect registration')),
        }),
      ).rejects.toThrow('worker lost');
      const count = await w.receiptsOf(id);
      const other = await bound(id, { seam: OTHER_SEAM });
      expect(await publish(id, other.ports())).toEqual({
        kind: 'refused',
        code: 'BINDING_NOT_THIS_CORRECTION',
        waitsOn: 'person',
      });
      expect(await w.receiptsOf(id)).toBe(count);
      expect(other.raised).toEqual(['BINDING_NOT_THIS_CORRECTION']);
      expect(other.site.sent).toEqual([]);
      expect(other.captured).toEqual([]);
    });

    it('adds no receipts or reconciliation task for an unknown revert on another binding', async () => {
      const id = await approved();
      const own = await bound(id);
      expect(await publish(id, own.ports())).toMatchObject({ kind: 'recorded', state: 'live' });
      await expect(
        revert(id, {
          ...own.ports(),
          revert: () => Promise.reject(new Error('worker lost before effect registration')),
        }),
      ).rejects.toThrow('worker lost');
      const count = await w.receiptsOf(id);
      const other = await bound(id, { seam: OTHER_SEAM });
      expect(await revert(id, other.ports())).toEqual({
        kind: 'refused',
        code: 'BINDING_NOT_THIS_CORRECTION',
        waitsOn: 'person',
      });
      expect(await w.receiptsOf(id)).toBe(count);
      expect(other.raised).toEqual(['BINDING_NOT_THIS_CORRECTION']);
      expect(other.site.sent).toEqual([]);
      expect(other.captured).toEqual([]);
    });
  },
);

describe.skipIf(serverUrl === undefined)('C80 publication uses the stored approval', () => {
  it('writes nothing when the binding holds bytes other than the stored approval', async () => {
    const id = await approved();
    const { site, ports } = await bound(id, {
      change: { before: BEFORE, after: 'unapproved bytes' },
    });
    site.state.proposed = 'unapproved proposal bytes';
    const outcome = await publish(id, ports());
    expect(outcome).toMatchObject({ kind: 'recorded' });
    expect(outcome).not.toMatchObject({ state: 'live' });
    expect(site.state.content).toBe(BEFORE);
    expect(site.sent.filter((sent) => sent.method !== 'GET')).toEqual([]);
  });

  it('publishes an unchanged BOM-bearing pre-image with the BOM preserved', async () => {
    const before = '\uFEFF' + BEFORE;
    const after = '\uFEFF' + AFTER;
    const id = await approved(before);
    const { site, ports } = await bound(id, { approved: { before, after } });
    expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(site.state.content).toBe(after);
    expect(advances(site)).toHaveLength(1);
  });
});
