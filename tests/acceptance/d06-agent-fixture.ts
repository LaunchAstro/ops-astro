// SPDX-License-Identifier: AGPL-3.0-only
//
// D06's agent journey fixture (`d06-agent.test.ts`): the one delegation the
// agent holds, picked up from a freshly approved reservation, remembered from
// whatever pickup the server granted, and given back by the person who
// granted it. An agent may hold one delegation at a time. Kept in its own
// file so the test stays under its cap.

import { expect } from 'vitest';
import type { Harness } from './role-case-harness.ts';
import type { Answer } from './world.ts';

export interface Pickup {
  readonly credential: string;
  readonly delegationId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly taskId: string;
  readonly attemptId: string;
}

export interface AgentHold {
  /** A reservation a person approved, ready to be picked up. */
  reservation(): Promise<string>;
  /** Remember a pickup the server granted, whether or not the cell wanted it. */
  track(answer: Answer): void;
  /** Give the held delegation back through its owning operation, as the person who granted it. */
  release(): Promise<void>;
  /** Forget the held delegation, which a handback settled. */
  settled(): void;
  ensureLive(): Promise<Pickup>;
}

/** The hold over the harness `harness()` answers, read at each call (it is built in `beforeAll`). */
export function agentHold(harness: () => Harness): AgentHold {
  let live: Pickup | undefined;
  const hold: AgentHold = {
    async reservation() {
      const { decided } = await harness().approvedReservation();
      expect(decided.code, 'the decision a pickup needs').toBe('ok');
      return String((decided.body['detail'] as Record<string, unknown>)['reservationId']);
    },
    track(answer) {
      if (answer.code !== 'ok') return;
      const detail = answer.body['detail'] as Record<string, unknown>;
      live = {
        credential: String(detail['credential']),
        delegationId: String(detail['delegationId']),
        leaseId: String(detail['leaseId']),
        fence: Number(detail['fence']),
        taskId: String(detail['taskId']),
        attemptId: String(detail['attemptId']),
      };
    },
    async release() {
      if (live === undefined) return;
      await harness().asPerson('delegation.revoke', { delegationId: live.delegationId });
      live = undefined;
    },
    settled() {
      live = undefined;
    },
    async ensureLive() {
      if (live === undefined) {
        hold.track(
          await harness().asAgent('task.pickup', { reservationId: await hold.reservation() }),
        );
      }
      if (live === undefined) throw new Error('d06-agent: the journey could not pick up');
      return live;
    },
  };
  return hold;
}
