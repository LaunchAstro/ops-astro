// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner ports, bound to the providers: each one a catalogued
// operation through the one guarded call (`callConnector`, through the
// site binding in `core-connectors`), and the capture the C18-1 fence's own
// inputs. Nothing here reaches a provider any other way, and nothing here
// holds a credential: custody's port borrows one per call.
//
// The binding is one correction's proposal, made from its party's site
// (`siteBindingFor`): the runner refuses any other correction on these ports
// before it reads or sends anything (`unbound`). Its branch is the
// correction's seam, so a read back, publish or revert for any other seam
// sends nothing, and a publish of any version but the one it proposed sends
// nothing either.
// A read back answers absent only on proof that nothing landed (the request
// unmerged; the published change still at the default branch head), and
// unknown otherwise: neither read names the commit a landing made, so a
// landing it cannot place waits on a person. Every refusal and unknown the
// guarded calls and the fence record on this run is kept, by code only, for
// the receipt.

import {
  bindingRefuses,
  callConnector,
  mergeAndFind,
  readServed,
  readSiteSource,
  revertForward,
  siteOperation,
  type BindingDependencies,
  type CaptureOptions,
  type ReadBack,
  type SiteBinding,
} from '../../../core-connectors/src/index.ts';
import type { RunnerPorts } from './live-correction-runner.ts';

export interface SitePortDependencies extends Omit<BindingDependencies, 'record'> {
  /** The fence's inputs for `site.capture`: the catalogue pool, a resolver, the pinned transport. */
  readonly capture: CaptureOptions;
  readonly raiseTask: (reason: string) => Promise<void>;
  readonly now: () => number;
}

const ABSENT = { state: 'absent' } as const;
const UNKNOWN = { state: 'unknown' } as const;

/** The runner's ports for one correction's proposal, every provider call guarded. */
export function siteRunnerPorts(binding: SiteBinding, deps: SitePortDependencies): RunnerPorts {
  const codes: string[] = [];
  const guarded: BindingDependencies = {
    transport: deps.transport,
    resolve: deps.resolve,
    credential: deps.credential,
    wait: deps.wait,
    record: (code) => codes.push(code),
  };
  const ours = (seam: string): boolean => {
    if (seam === binding.proposal.branch) return true;
    codes.push('SEAM_MISMATCH');
    return false;
  };
  const fenceRecord = deps.capture.record;
  return {
    readSource: async () => await readSiteSource(binding, guarded),
    // `site.request.read`: absent only while the request is unmerged.
    readBack: async ({ seam }): Promise<ReadBack<never>> => {
      if (!ours(seam)) return UNKNOWN;
      const read = await callConnector(
        siteOperation('site.request.read'),
        { repository: binding.repository, number: binding.proposal.request },
        guarded,
      );
      return read.kind === 'ok' && read.value['merged'] === false ? ABSENT : UNKNOWN;
    },
    publish: async (input) => await mergeAndFind(binding, input, guarded),
    readDeployment: async (deploymentId) => await readServed(deploymentId, guarded),
    capture: {
      ...deps.capture,
      record: (refusal) => {
        codes.push(refusal.code);
        fenceRecord?.(refusal);
      },
    },
    // `site.source.read` of the default branch head: absent only while it holds the published change.
    revertReadBack: async ({ seam }): Promise<ReadBack<never>> => {
      if (!ours(seam)) return UNKNOWN;
      const head = await readSiteSource(binding, guarded);
      return head.kind === 'ok' && head.value.content === binding.change.after ? ABSENT : UNKNOWN;
    },
    revert: async (input) => await revertForward(binding, input, guarded),
    raiseTask: deps.raiseTask,
    now: deps.now,
    refusals: () => [...codes],
    unbound: (correction) => bindingRefuses(binding, correction),
  };
}
