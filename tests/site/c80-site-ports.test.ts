// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner on its site ports: runLivePublish and runLiveRevert through
// siteRunnerPorts, every provider call through the binding's guarded calls
// over the providers' double (c80-site-provider.ts). A publish lands live and
// its revert lands reverted; a binding for another seam sends nothing past the
// source read; a request another worker merged first ends unknown, never
// failed, with its code on the receipt. The ports bind through the
// correction's party's site (#989 criterion 2), and run no other correction:
// a correction of party A naming party B's page, or a binding of party B,
// sends and captures nothing. Nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import { ABOUT, AFTER, BEFORE, PAGE } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { HEAD, PROJECT, REPOSITORY, line, provider, type Provider } from './c80-site-provider.ts';
import { siteRunnerPorts, type RunnerPorts } from '../../packages/core-commands/src/index.ts';
import {
  siteBindingFor,
  type PartySite,
  type SiteBinding,
  type Transport,
} from '../../packages/core-connectors/src/index.ts';
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

const SOURCE = 'GET /repos/agency/site/contents/src/pages/about.md';
const REQUEST = 'GET /repos/agency/site/pulls/17';
const MERGE = 'PUT /repos/agency/site/pulls/17/merge';
const OTHER_SEAM = 'seam-00000000-0000-4000-8000-000000000000';
/** Party B's catalogued page and its source file: on B's site, never A's. */
const B_PAGE = 'https://client-b.example/team/';
const B_FILE = 'src/pages/team.md';

/** Party A's site: the About page and its file, on the double's providers. */
const siteOf = (partyId: string): PartySite => ({
  partyId,
  repository: REPOSITORY,
  defaultBranch: 'main',
  project: PROJECT,
  pages: [{ pageUrl: PAGE, path: ABOUT }],
});

const page = (text: string): Uint8Array =>
  new TextEncoder().encode(`<!doctype html><html><body><main>${text}</main></body></html>`);

interface Bound {
  readonly site: Provider;
  readonly raised: string[];
  /** Every page address the fence's transport was asked for. */
  readonly captured: string[];
  /** Fresh ports for one run, bound to the correction's proposal on the double. */
  readonly ports: () => RunnerPorts;
}

/** The correction as stored: what its binding is made from. */
async function pinOf(id: string) {
  const rows = await w.world.db.admin.execute<{
    seam: string;
    version: string;
    partyId: string;
    pageUrl: string;
    targetPath: string;
  }>(
    `select seam, version_digest as version, party_id as "partyId", page_url as "pageUrl",
            target_path as "targetPath"
       from public.live_corrections where id = $1`,
    [id],
  );
  const pin = rows[0];
  if (pin === undefined) throw new Error('no correction');
  return pin;
}

/** The pin's binding on a party's site: the pin's own party and seam unless named. */
function bindingOf(
  pin: Awaited<ReturnType<typeof pinOf>>,
  named: { readonly seam?: string | undefined; readonly party?: string | undefined },
): SiteBinding {
  const partyId = named.party ?? pin.partyId;
  const made = siteBindingFor(
    siteOf(partyId),
    { ...pin, partyId, seam: named.seam ?? pin.seam },
    {
      proposal: { request: '17', head: HEAD, versionDigest: pin.version },
      change: { before: BEFORE, after: AFTER },
    },
  );
  if (!made.ok) throw new Error(`not bound: ${made.code}`);
  return made.binding;
}

interface Given {
  readonly seam?: string;
  /** The correction whose proposal the ports are bound to, when not `id`'s. */
  readonly boundTo?: string;
  /** The party the binding is made for, on its own site, when not the correction's. */
  readonly party?: () => string;
  readonly wrap?: (site: Provider) => Transport;
  /** The page's status as served: anything but 200 the fence refuses. */
  readonly status?: number;
}

/** The providers holding this correction's proposal, its page served from the site file. */
async function bound(id: string, given: Given = {}): Promise<Bound> {
  const { seam, wrap = (site: Provider) => site.deps.transport, status = 200 } = given;
  const pin = await pinOf(given.boundTo ?? id);
  const site = provider({
    content: BEFORE,
    branches: ['main', pin.seam],
    proposed: AFTER,
    request: { number: 17, head: HEAD, merged: false },
  });
  const binding = bindingOf(pin, { seam, party: given.party?.() });
  const raised: string[] = [];
  const captured: string[] = [];
  let clock = 5_000;
  const served: Transport = (request) => {
    captured.push(request.url.href);
    return Promise.resolve({
      kind: 'answer',
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: page(site.state.content),
    });
  };
  const ports = () =>
    siteRunnerPorts(binding, {
      ...site.deps,
      transport: wrap(site),
      // Party B's page is catalogued too: only the binding keeps A's run off it.
      capture: {
        ...doubles().capture,
        pool: { agencyPages: [PAGE, B_PAGE], otherPages: [], closedPoolReviews: [] },
        transport: served,
      },
      raiseTask: (reason) => {
        raised.push(reason);
        return Promise.resolve();
      },
      now: () => (clock += 250),
    });
  return { site, raised, captured, ports };
}

const refusalsOn = async (id: string, step: string): Promise<string[]> =>
  ((await receipt(id, step))['refusals_raised']?.observed ?? '').split(' ');

describe.skipIf(serverUrl === undefined)('C80 runner on the site ports', () => {
  it('publishes the approved proposal live, then reverts it forward', async () => {
    const id = await approved();
    const { site, ports } = await bound(id);
    expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(site.sent.map(line)).toEqual([
      SOURCE,
      REQUEST,
      SOURCE,
      MERGE,
      'GET /v6/deployments?projectId=prj_site&sha=c0ffee02&target=production&limit=1',
      'GET /v13/deployments/dpl_merged',
    ]);
    expect(site.state.content).toBe(AFTER);
    site.sent.length = 0;
    expect(await revert(id, ports())).toMatchObject({ kind: 'recorded', state: 'reverted' });
    expect(site.sent.map(line)).toEqual([
      SOURCE,
      SOURCE,
      'PUT /repos/agency/site/contents/src/pages/about.md',
      'GET /v6/deployments?projectId=prj_site&sha=c0ffee03&target=production&limit=1',
      'GET /v13/deployments/dpl_reverted',
    ]);
    expect(site.state.content).toBe(BEFORE);
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 runner on the site ports: what it cannot place',
  () => {
    it('ends unknown, never failed, when another worker merged the request first', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id, {
        wrap: (double) => async (request) => {
          const answer = await double.deps.transport(request);
          // Another worker's merge lands just after this run read the request unmerged.
          if (request.url.pathname.endsWith('/pulls/17') && double.state.request !== undefined)
            double.state.request.merged = true;
          return answer;
        },
      });
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(site.sent.map(line)).toEqual([SOURCE, REQUEST, SOURCE, MERGE, REQUEST]);
      expect(await w.stateOf(id)).toBe('unknown');
      expect(raised).toContain('REQUEST_ALREADY_MERGED');
      expect(await refusalsOn(id, 'publish')).toContain('REQUEST_ALREADY_MERGED');
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
      // Stored today: the request does not yet read a party's site (#989's request-time half).
      const crossing = await approved({ pageUrl: B_PAGE, path: B_FILE });
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
