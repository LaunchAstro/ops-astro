// SPDX-License-Identifier: AGPL-3.0-only

import { ABOUT, AFTER, BEFORE, PAGE } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { HEAD, PROJECT, REPOSITORY, provider, type Provider } from './c80-site-provider.ts';
import { siteRunnerPorts, type RunnerPorts } from '../../packages/core-commands/src/index.ts';
import {
  siteBindingFor,
  type PartySite,
  type SiteBinding,
  type Transport,
} from '../../packages/core-connectors/src/index.ts';
import { w } from './c80-register-world.ts';

export const OTHER_SEAM = 'seam-00000000-0000-4000-8000-000000000000';
/** Party B's catalogued page and its source file: on B's site, never A's. */
export const B_PAGE = 'https://client-b.example/team/';
export const B_FILE = 'src/pages/team.md';

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
  readonly change?: SiteBinding['change'];
}

/** The providers holding this correction's proposal, its page served from the site file. */
export async function bound(id: string, given: Given = {}): Promise<Bound> {
  const { seam, wrap = (site: Provider) => site.deps.transport, status = 200 } = given;
  const pin = await pinOf(given.boundTo ?? id);
  const site = provider({
    content: BEFORE,
    branches: ['main', pin.seam],
    proposed: AFTER,
    request: { number: 17, head: HEAD, merged: false },
  });
  const binding = {
    ...bindingOf(pin, { seam, party: given.party?.() }),
    ...(given.change === undefined ? {} : { change: given.change }),
  };
  site.state.content = binding.change.before;
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
