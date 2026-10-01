// SPDX-License-Identifier: AGPL-3.0-only
//
// What a mutation answers the typed client, split out of `client.ts` when the main merge joined
// it past the 300-line limit; `client.ts` re-exports both types.

import type { PlanOffer } from '../../../../packages/core-wire/src/index.ts';

/** What a mutation returns when it worked: a durable handle and a new revision. */
export interface CommandOutcome {
  readonly recordId: string;
  readonly revision: number;
  /**
   * Whatever the operation has to say about what it did, in its own words.
   *
   * It is the envelope's third field (`commands/outcome.ts`) and the API passes it through
   * unchanged. `task.comment` puts the new comment's identifier in it; the two settings commands
   * put the key and the value the row now holds, which is the only thing in this build that tells
   * a caller what a setting was set to — there is no settings read. Optional, because most
   * operations have nothing to add beyond the handle and the revision.
   */
  readonly detail?: Readonly<Record<string, unknown>>;
  /**
   * AW-03: the agent's answer beside a message the person just kept, or why
   * there is none, where the deployment answers conversations. Absent, the
   * message is kept and nothing answers it.
   */
  readonly reply?: ConversationReply;
}

export type ConversationReply =
  | {
      readonly answered: true;
      readonly messageId: string;
      readonly body: string;
      /** AW-04: the plan version a planning reply composed, drawn as a card. */
      readonly plan?: PlanOffer;
    }
  | { readonly answered: false; readonly code: string; readonly words: string };
