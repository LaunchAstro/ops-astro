// SPDX-License-Identifier: AGPL-3.0-only
//
// Work the worker holds from one pass to the next keeps its lease, and so the
// delegation its pickup minted with it, alive (owner ruling, 11 October 2026):
// one `task.heartbeat` once half of what was left of the lease has passed.
// Nothing beats for work it does not hold, and a lease handed back or
// observed simply stops being beaten.

import { agentCall, type AgentLogin } from './agent-call.ts';

/** Picked-up work, as far as keeping it alive goes. */
export interface Leased {
  readonly lease: { readonly leaseId: unknown; readonly fence: unknown };
  /** The delegation its pickup minted. */
  readonly credential: string;
  /** When its lease is next kept alive. */
  readonly beatAt: number;
}

/** Halfway from now to the lease's `expiresAt`; now when it names none. */
export const halfway = (expiresAt: unknown, now: number = Date.now()): number =>
  now + Math.max(0, (Date.parse(String(expiresAt)) || now) - now) / 2;

/** `held`, its lease beaten when due. The answer only moves the next beat: the resumed step says whether the work is still held. */
export async function keptAlive<Held extends Leased>(login: AgentLogin, held: Held): Promise<Held> {
  if (Date.now() < held.beatAt) return held;
  const beat = await agentCall(login, held.credential)('task.heartbeat', held.lease);
  return 'body' in beat ? { ...held, beatAt: halfway(beat.detail['expiresAt']) } : held;
}
