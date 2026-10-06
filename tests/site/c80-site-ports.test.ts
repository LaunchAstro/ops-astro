// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner on its site ports: runLivePublish and runLiveRevert through
// siteRunnerPorts, every provider call through the binding's guarded calls
// over the providers' double (c80-site-provider.ts). A publish lands live and
// its revert lands reverted; a binding for another seam sends nothing past the
// source read; a request another worker merged first ends unknown, never
// failed, with its code on the receipt. Nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import { AFTER, BEFORE } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { HEAD, binding as fixed, line, provider, type Provider } from './c80-site-provider.ts';
import { siteRunnerPorts, type RunnerPorts } from '../../packages/core-commands/src/index.ts';
import type { SiteBinding, Transport } from '../../packages/core-connectors/src/index.ts';
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

const page = (text: string): Uint8Array =>
  new TextEncoder().encode(`<!doctype html><html><body><main>${text}</main></body></html>`);

interface Bound {
  readonly site: Provider;
  readonly raised: string[];
  /** Fresh ports for one run, bound to the correction's proposal on the double. */
  readonly ports: () => RunnerPorts;
}

/** The providers holding this correction's proposal, its page served from the site file. */
async function bound(
  id: string,
  given: {
    readonly seam?: string;
    readonly wrap?: (site: Provider) => Transport;
    /** The page's status as served: anything but 200 the fence refuses. */
    readonly status?: number;
  } = {},
): Promise<Bound> {
  const { seam, wrap = (site: Provider) => site.deps.transport, status = 200 } = given;
  const rows = await w.world.db.admin.execute<{ seam: string; version: string }>(
    `select seam, version_digest as version from public.live_corrections where id = $1`,
    [id],
  );
  const pin = rows[0];
  if (pin === undefined) throw new Error('no correction');
  const site = provider({
    content: BEFORE,
    branches: ['main', pin.seam],
    proposed: AFTER,
    request: { number: 17, head: HEAD, merged: false },
  });
  const binding: SiteBinding = {
    ...fixed,
    proposal: { branch: seam ?? pin.seam, request: '17', head: HEAD, versionDigest: pin.version },
    change: { before: BEFORE, after: AFTER },
  };
  const raised: string[] = [];
  let clock = 5_000;
  const served: Transport = () =>
    Promise.resolve({
      kind: 'answer',
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: page(site.state.content),
    });
  const ports = () =>
    siteRunnerPorts(binding, {
      ...site.deps,
      transport: wrap(site),
      capture: { ...doubles().capture, transport: served },
      raiseTask: (reason) => {
        raised.push(reason);
        return Promise.resolve();
      },
      now: () => (clock += 250),
    });
  return { site, raised, ports };
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

  it('sends nothing past the source read for a binding on another seam', async () => {
    const id = await approved();
    const { site, ports } = await bound(id, { seam: OTHER_SEAM });
    expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
    expect(site.sent.map(line)).toEqual([SOURCE]);
    expect(site.state.request?.merged).toBe(false);
    expect(await refusalsOn(id, 'publish')).toContain('SEAM_MISMATCH');
  });

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
});
