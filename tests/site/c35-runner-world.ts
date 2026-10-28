// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's review captures against the real queue and API (#2013): C35's world
// (`c35-world.ts`) with a review's capture put on the queue as a person's approved
// `review_capture` step, the runner's agent calls through the agent envelope as the host
// makes them, and a replay of the agency's about page behind the fence's transport.

import { randomUUID } from 'node:crypto';
import type { AgentCall } from '../../apps/site-runner/claims.ts';
import {
  CAPTURE_PURPOSE,
  reviewCaptures,
  type Captured,
  type SizedBrowser,
} from '../../apps/site-runner/review-captures.ts';
import type {
  CapturePool,
  Transport,
  TransportAnswer,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { PAGE, type C35World, type Reviewed } from '../review/c35-world.ts';
import { CSS, PAGE as PAGE_HTML, publicResolver } from './c80-picture-world.ts';

export { PAGE, publicResolver };

/** The agency's about page and its stylesheet, as the replay serves them. */
export const SHEET: string = new URL('/_astro/site.css', PAGE).href;

/** The fence's pool on the agency's own site: its about page alone. */
export const AGENCY_POOL: CapturePool = {
  agencyPages: [PAGE],
  otherPages: [],
  closedPoolReviews: [],
};

const answer = (type: string, body: string): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': type },
  body: new TextEncoder().encode(body),
});

const MISSING: TransportAnswer = {
  kind: 'answer',
  status: 404,
  headers: {},
  body: new Uint8Array(),
};

/** The agency's about page and its stylesheet, as the replay serves them unless told otherwise. */
const ABOUT_SITE: Readonly<Record<string, TransportAnswer>> = {
  [PAGE]: answer('text/html; charset=utf-8', PAGE_HTML),
  [SHEET]: answer('text/css', CSS),
};

/** The replay site: every request it is asked, and the pages it serves. */
export function replay(
  pages: Readonly<Record<string, TransportAnswer>> = ABOUT_SITE,
): Transport & { readonly asked: TransportRequest[] } {
  const asked: TransportRequest[] = [];
  const transport = (request: TransportRequest) => {
    asked.push(request);
    return Promise.resolve(pages[request.url.href] ?? MISSING);
  };
  return Object.assign(transport, { asked });
}

const need = (result: CommandResult, what: string): Record<string, unknown> => {
  if (isCommandRefusal(result)) throw new Error(`c35 runner world: ${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), revision: result.revision };
};

/** ava puts the review's capture on the queue: a `review_capture` step on its task, approved. */
export async function queueCapture(w: C35World, reviewed: Reviewed): Promise<void> {
  const [row] = await w.world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [w.world.business, reviewed.taskId],
  );
  const proposed = need(
    await w.as(w.ava, {
      command: 'task.propose',
      recordId: reviewed.taskId,
      expectedRevision: Number(row?.revision),
      purpose: CAPTURE_PURPOSE,
      maximumMinor: 1,
      currency: 'AUD',
      payload: { instruction: 'capture the page under review' },
      step: { kind: 'compose', payload: {} },
    }),
    'task.propose',
  );
  need(
    await w.as(w.ava, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'capture it',
    }),
    'task.decide',
  );
}

/** Every agent call the runner made: its verb, its body and the pickup it went under. */
export interface Sent {
  readonly verb: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly pickup: string | undefined;
  readonly answer: unknown;
}

/** The runner's agent calls through the agent envelope, each recorded with its answer. */
export function agentCalls(w: C35World): AgentCall & { readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const call: AgentCall = async (verb, body, pickup) => {
    const result = await w.world.asAgent(
      { command: verb, operationId: randomUUID(), ...body },
      pickup,
    );
    const answered = isCommandRefusal(result)
      ? { refused: result.code }
      : { detail: result.detail as Readonly<Record<string, unknown>> };
    sent.push({ verb, body, pickup, answer: answered });
    return answered;
  };
  return Object.assign(call, { sent });
}

/** One capture pass of the runner as the host composes it, on `transport` and `browserAt`. */
export const capturePass = async (
  w: C35World,
  at: {
    readonly call: AgentCall;
    readonly transport: Transport;
    readonly browserAt: SizedBrowser;
    readonly pool?: CapturePool;
  },
): Promise<readonly Captured[]> =>
  await reviewCaptures({
    call: at.call,
    db: w.world.db.app,
    business: w.world.business as BusinessId,
    capture: { pool: at.pool ?? AGENCY_POOL, resolve: publicResolver, transport: at.transport },
    browserAt: at.browserAt,
  })();

/** The task's newest lease, as the administrator sees it. */
export async function leaseOn(
  w: C35World,
  taskId: string,
): Promise<{ readonly id: string; readonly state: string; readonly holder: string } | undefined> {
  const [row] = await w.world.db.admin.execute<{ id: string; state: string; holder: string }>(
    `select id, state, holder_actor_id::text as holder from public.leases
      where task_id = $1 order by fence desc limit 1`,
    [taskId],
  );
  return row;
}
