// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's provider ports, bound to custody (`docs/local/SITE-RUNNER.md`,
// "Credentials and egress"). Every catalogued call is handed to custody by its
// entry's name (`siteCustody`), so this process never holds a site token, and
// its own transport sends nothing: a call that tried to leave any other way is
// refused here. The capture goes only through the C18-1 fence, to the agency's
// bound pages on public addresses. Production has no catalogued read of a
// branch's head or an open request by its branch, so those two seam reads
// refuse, and a proposal whose answer was lost waits on a person.

import {
  siteRunnerPorts,
  type ProposePorts,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';
import {
  callConnector,
  siteOperation,
  type BindingDependencies,
  type CapturePool,
  type Resolver,
  type SiteBinding,
  type Transport,
} from '../../packages/core-connectors/src/index.ts';
import { siteCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import type { PartySiteRecord } from '../../packages/core-records/src/index.ts';
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

const NOT_CATALOGUED = { kind: 'refused', code: 'SEAM_READ_NOT_CATALOGUED' } as const;

/** Custody carries every guarded call; the caller's own transport sends nothing. */
function guarded(ports: SitePorts): BindingDependencies {
  return {
    transport: () => Promise.resolve({ kind: 'failed' }),
    resolve: ports.resolve,
    credential: (ref) => Promise.resolve({ ref }),
    custody: siteCustody(ports.custody),
    // The publish ports keep their own record (`siteRunnerPorts`); the proposal step reads its seam.
    record: () => null,
    wait: ports.wait,
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

export function custodySites(ports: SitePorts): Sites {
  return {
    propose: (site, path, raiseTask) => {
      const deps = guarded(ports);
      return {
        connector: deps,
        file: fileAt(site, path, deps),
        branch: () => Promise.resolve(NOT_CATALOGUED),
        request: () => Promise.resolve(NOT_CATALOGUED),
        raiseTask,
      };
    },
    publish: (binding: SiteBinding, raiseTask): RunnerPorts =>
      siteRunnerPorts(binding, {
        ...guarded(ports),
        capture: ports.capture,
        raiseTask,
        now: ports.now,
      }),
  };
}
