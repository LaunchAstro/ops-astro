// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner ports, bound to the providers: each one a catalogued
// operation through the one guarded call (`callConnector`, through the
// site binding in `core-connectors`), and the capture the C18-1 fence's own
// inputs. Nothing here reaches a provider any other way, and nothing here
// holds a credential: custody's port borrows one per call.
//
// The binding is one correction's proposal: its branch is the correction's
// seam, so a publish or revert for any other seam sends nothing, and a publish
// of any version but the one it proposed sends nothing either. Every
// refusal and unknown the guarded calls and the fence record on this run is
// kept, by code only, for the receipt.

import {
  mergeAndFind,
  readServed,
  readSiteSource,
  revertForward,
  type BindingDependencies,
  type CaptureOptions,
  type SiteBinding,
} from '../../../core-connectors/src/index.ts';
import type { RunnerPorts } from './live-correction-runner.ts';

export interface SitePortDependencies extends Omit<BindingDependencies, 'record'> {
  /** The fence's inputs for `site.capture`: the catalogue pool, a resolver, the pinned transport. */
  readonly capture: CaptureOptions;
  readonly raiseTask: (reason: string) => Promise<void>;
  readonly now: () => number;
}

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
  const fenceRecord = deps.capture.record;
  return {
    readSource: async () => await readSiteSource(binding, guarded),
    publish: async (input) => await mergeAndFind(binding, input, guarded),
    readDeployment: async (deploymentId) => await readServed(deploymentId, guarded),
    capture: {
      ...deps.capture,
      record: (refusal) => {
        codes.push(refusal.code);
        fenceRecord?.(refusal);
      },
    },
    revert: async (input) => await revertForward(binding, input, guarded),
    raiseTask: deps.raiseTask,
    now: deps.now,
    refusals: () => [...codes],
  };
}
