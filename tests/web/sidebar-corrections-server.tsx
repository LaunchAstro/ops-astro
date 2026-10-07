// SPDX-License-Identifier: AGPL-3.0-only
//
// The sidebar correction suites' server stand-in that tells parties and
// people apart, as `live-corrections.ts` filters inside its query.

import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { V1, refusal } from './sidebar-corrections-support.tsx';

export const CLIENT_A = '11111111-1111-4111-8111-111111111111';
export const CLIENT_B = '44444444-4444-4444-8444-444444444444';

export interface Kept {
  readonly party: string;
  readonly state: string;
  readonly approver: string | null;
  readonly versionId: string;
}

/** Who holds a grant on which client, and the corrections the business holds. */
interface World {
  readonly grants: Readonly<Record<string, readonly string[]>>;
  readonly kept: Record<string, Kept>;
}

/**
 * The server's answer to one call under `session`. A correction is read or
 * decided only under a session whose grant covers its party, and any other
 * is not found, as `live-corrections.ts` filters inside its query. A request
 * on a party the session holds no grant on is refused.
 */
function answer(world: World, call: Call, nth: number): Response {
  const { path, session, body } = call;
  const covers = (party: string): boolean => (world.grants[session] ?? []).includes(party);
  if (path === '/live_correction/request') {
    const party = String(body['partyId']);
    if (!covers(party)) return refusal('SCOPE_NOT_GRANTED', 403);
    const correctionId = `c-${String(nth)}`;
    world.kept[correctionId] = { party, state: 'requested', approver: null, versionId: V1 };
    return json({
      recordId: correctionId,
      revision: 1,
      detail: { correctionId, state: 'requested' },
    });
  }
  const correctionId = String(body['correctionId']);
  const one = world.kept[correctionId];
  if (one === undefined || !covers(one.party)) return refusal('NOT_FOUND', 404);
  if (path === '/live_correction/read') {
    const { state, approver, versionId } = one;
    return json({ ok: true, correction: { correctionId, state, approver, versionId } });
  }
  if (path === '/live_correction/decide') return json({ recordId: correctionId, revision: 2 });
  return refusal('NOT_FOUND', 404);
}

interface Call {
  readonly path: string;
  readonly session: string;
  readonly body: Record<string, unknown>;
}

/**
 * One business's server stand-in that tells parties and people apart: each
 * call is answered under the session it carries (`answer`). `hold` keeps
 * every answer back until `release`, for an answer that lands late.
 */
export function separated(
  businessKey: string,
  grants: Readonly<Record<string, readonly string[]>>,
  kept: Record<string, Kept>,
) {
  const calls: Call[] = [];
  const held: (() => void)[] = [];
  let holding = false;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (!at.includes(`/api/b/${businessKey}/`)) throw new Error(`${businessKey} client sent ${at}`);
    const path = at.slice(at.indexOf(`/api/b/${businessKey}`) + `/api/b/${businessKey}`.length);
    const session = new Headers(init?.headers).get(SESSION_HEADER) ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, session, body });
    const answered = answer({ grants, kept }, { path, session, body }, calls.length);
    if (!holding) return Promise.resolve(answered);
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(answered);
      });
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    as: (sessionId: string) =>
      new OperationsClient({ origin: '', businessKey, signedIn: true, sessionId, fetch }),
    sent: (path: string) => calls.filter((call) => call.path === path),
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      for (const go of held.splice(0)) go();
      await tick();
    },
  };
}
