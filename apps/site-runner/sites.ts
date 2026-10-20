// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's provider ports, bound to custody (`docs/local/SITE-RUNNER.md`,
// "Credentials and egress"). Every catalogued call is handed to custody by its
// entry's name (`siteCustody`), so this process never holds a site token, and
// its own transport sends nothing: a call that tried to leave any other way is
// refused here. Every call is first checked against the one configured site
// (`admitting`): a repository, branch, path, project or page it does not hold
// is `SITE_NOT_CONFIGURED` with nothing sent, whatever the token could reach.
// The capture goes only through the C18-1 fence, to the agency's bound pages
// on public addresses. Production has no catalogued read of a branch's head
// by its seam or an open request by its branch, so those two seam reads
// refuse, and a proposal whose answer was lost waits on a person.

import {
  siteRunnerPorts,
  type ProposePorts,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';
import {
  callConnector,
  SITE_OPERATIONS,
  siteOperation,
  type BindingDependencies,
  type CapturePool,
  type ProviderResult,
  type ProviderValue,
  type Resolver,
  type SiteBinding,
  type Transport,
} from '../../packages/core-connectors/src/index.ts';
import {
  siteCustody,
  siteDestination,
  type Custody,
  type Destination,
} from '../../packages/core-custody/src/index.ts';
import type { PartySiteRecord } from '../../packages/core-records/src/index.ts';
import { admitting, type ConfiguredSite } from './configured.ts';
import type { Sites } from './runner.ts';

export interface SitePorts {
  readonly custody: Pick<Custody, 'dispatch'>;
  /** Resolves a catalogued host, as the guarded call checks it before handing the call to custody. */
  readonly resolve: Resolver;
  /** The fence's inputs: the agency's own pages, the resolver and the pinned transport. */
  readonly capture: {
    readonly pool: CapturePool;
    readonly resolve: Resolver;
    readonly transport: Transport;
  };
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** The locate's two reads, at the configured site's repository and default branch (#1693). */
export interface LocatePorts {
  /** `site.source.head`: the default branch's head commit, as answered. */
  readonly head: () => Promise<ProviderResult<ProviderValue>>;
  /** `site.source.read`: a configured page's file at a commit, as answered. */
  readonly file: (path: string, ref: string) => Promise<ProviderResult<ProviderValue>>;
}

export interface RunnerSites extends Sites {
  readonly locate: () => LocatePorts;
}

const NOT_CATALOGUED = { kind: 'refused', code: 'SEAM_READ_NOT_CATALOGUED' } as const;

/** Custody carries every guarded call, each admitted first; the caller's own transport sends nothing. */
function guarded(ports: SitePorts, admit: BindingDependencies['admit']): BindingDependencies {
  return {
    transport: () => Promise.resolve({ kind: 'failed' }),
    resolve: ports.resolve,
    credential: (ref) => Promise.resolve({ ref }),
    custody: siteCustody(ports.custody),
    // The publish ports keep their own record (`siteRunnerPorts`); the proposal step reads its seam.
    record: () => null,
    wait: ports.wait,
    ...(admit === undefined ? {} : { admit }),
  };
}

/** `site.source.read` of the site file at a commit: its blob and its text. */
function fileAt(
  site: PartySiteRecord,
  path: string,
  deps: BindingDependencies,
): ProposePorts['file'] {
  return async (ref) => {
    const read = await callConnector(
      siteOperation('site.source.read'),
      { repository: site.repository, path, ref },
      deps,
    );
    if (read.kind !== 'ok') return read;
    if (read.value['encoding'] !== 'base64')
      return { kind: 'refused', code: 'PROVIDER_RESPONSE_MALFORMED' };
    const content = Buffer.from(String(read.value['content']), 'base64').toString('utf8');
    return { kind: 'ok', value: { blob: String(read.value['sha']), content } };
  };
}

/** `site.source.head` of the site's default branch: its head commit now. */
function headOf(site: PartySiteRecord, deps: BindingDependencies): ProposePorts['head'] {
  return async () => {
    const read = await callConnector(
      siteOperation('site.source.head'),
      { repository: site.repository, branch: site.defaultBranch },
      deps,
    );
    return read.kind === 'ok' ? { kind: 'ok', value: String(read.value['object.sha']) } : read;
  };
}

/**
 * Custody's two site destinations. Locate only: each holds its catalogued reads and nothing
 * else, so no write can leave whatever the runner asks.
 */
export function siteDestinations(
  origins: { readonly source: string; readonly hosting: string },
  locateOnly: boolean,
): Destination[] {
  const routed = locateOnly
    ? SITE_OPERATIONS.filter((registration) => registration.connector.method === 'GET')
    : SITE_OPERATIONS;
  return [
    siteDestination('source_control', origins.source, routed),
    siteDestination('hosting', origins.hosting, routed),
  ];
}

export function custodySites(ports: SitePorts, site: ConfiguredSite): RunnerSites {
  return {
    propose: (bound, path, raiseTask) => {
      const deps = guarded(ports, admitting(site, { path }));
      return {
        connector: deps,
        head: headOf(bound, deps),
        file: fileAt(bound, path, deps),
        branch: () => Promise.resolve(NOT_CATALOGUED),
        request: () => Promise.resolve(NOT_CATALOGUED),
        raiseTask,
      };
    },
    publish: (binding: SiteBinding, raiseTask): RunnerPorts =>
      siteRunnerPorts(binding, {
        ...guarded(ports, admitting(site, { pageUrl: binding.pageUrl, path: binding.path })),
        capture: ports.capture,
        raiseTask,
        now: ports.now,
      }),
    locate: () => {
      const deps = guarded(ports, admitting(site));
      const { repository, defaultBranch: branch } = site;
      return {
        head: async () =>
          await callConnector(siteOperation('site.source.head'), { repository, branch }, deps),
        file: async (path, ref) =>
          await callConnector(siteOperation('site.source.read'), { repository, path, ref }, deps),
      };
    },
  };
}
