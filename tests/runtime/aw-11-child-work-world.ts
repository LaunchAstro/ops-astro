// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 child work: the runtime's hand-over, handback and merged result, as
// the child-work suites call them in the child world's businesses.

import type {
  ChildMintRequest,
  Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import {
  childResults,
  delegateChild,
  handBackChild,
  type ChildHandback,
} from '../../packages/core-runtime/src/index.ts';
import type { Schedules, Work } from './schedules-harness.ts';
import { childRequest, parentWork, type Helper } from './aw-11-child-world.ts';

/** `delegateChild` on `work`'s own lease and fence, as `parent`. */
export async function delegateOn(
  on: Schedules,
  parent: Delegation,
  work: Work,
  request: ChildMintRequest,
  fence: number = Number(work.picked['fence']),
): ReturnType<typeof delegateChild> {
  return await on.db.app.withBusiness(
    on.business,
    async (tx) =>
      await delegateChild(tx, parent, {
        leaseId: String(work.picked['leaseId']),
        fence,
        child: request,
      }),
  );
}

export async function handBack(
  on: Schedules,
  helper: Helper,
  credential: string,
  handback: ChildHandback,
): ReturnType<typeof handBackChild> {
  return await on.db.app.withBusiness(
    on.business,
    async (tx) => await handBackChild(tx, { agentActorId: helper.actorId, credential }, handback),
  );
}

export async function resultsOf(
  on: Schedules,
  parent: Delegation,
): ReturnType<typeof childResults> {
  return await on.db.app.withBusiness(on.business, async (tx) => await childResults(tx, parent));
}

export const codeOf = (result: { ok: boolean; refusal?: { code: string } }): string =>
  result.ok ? 'ok' : String(result.refusal?.code);

export async function delegated(
  on: Schedules,
  helper: Helper,
): Promise<{
  readonly work: Work;
  readonly parent: Delegation;
  readonly childId: string;
  readonly credential: string;
}> {
  const { work, parent } = await parentWork(on);
  const handed = await delegateOn(on, parent, work, childRequest(helper));
  if (!handed.ok) throw new Error(`the helper was not handed the work: ${handed.refusal.code}`);
  return {
    work,
    parent,
    childId: handed.value.childDelegationId,
    credential: handed.value.credential,
  };
}
