// SPDX-License-Identifier: AGPL-3.0-only
//
// The requests a streamed call makes of `codex app-server` (codex-app.ts), in
// order, each sent once the one before it is answered: initialize (the Codex
// the runner expects, the pinned version on its own home), the account (the
// ChatGPT plan's), the plan's usage (usage-guard.ts), the thread, then the
// turn. The prompt leaves the machine with the turn, so the turn is started
// only inside the call's send deadline; past it, the model is never asked.

import { realpathSync } from 'node:fs';
import { record } from './app-grammar.ts';
import { UNKNOWN, type CodexResult } from './codex.ts';
import type { Refused } from './gate.ts';
import { usageRefusal } from './usage-guard.ts';

/** What one streamed call ends with: as `runCodex`'s, or refused before the model was asked. */
export type AppResult = CodexResult | typeof UNKNOWN | Refused | null;

/** A call's outcome, and whether its child is killed at once or let go. */
export interface Ending {
  readonly result: AppResult;
  readonly kill: boolean;
}

/** A call the turn may or may not have reached: unknown once the turn was asked for, else nothing. */
export const broken = (turnStarted: boolean): Ending => ({
  result: turnStarted ? UNKNOWN : null,
  kill: true,
});

const refused = (code: Refused['refused']): Ending => ({ result: { refused: code }, kill: true });

/** One streamed call: what it asks, where, and by when its turn must start. */
export interface Plan {
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly codexHome: string;
  /** The version `initialize` must report, when pinned. */
  readonly codexVersion: string | null;
  /** The send deadline (Unix ms): no turn starts after it. None on the laptop. */
  readonly sendBy: number | null;
}

/** The Codex the child says it is: the pinned version, if any, on the runner's own home. */
function expectedCodex(result: Record<string, unknown> | undefined, plan: Plan): boolean {
  const agent = result?.['userAgent'];
  const home = result?.['codexHome'];
  if (typeof agent !== 'string' || typeof home !== 'string') return false;
  if (plan.codexVersion !== null && /^[^/\s]+\/(\S+)/u.exec(agent)?.[1] !== plan.codexVersion) {
    return false;
  }
  try {
    return realpathSync(home) === realpathSync(plan.codexHome);
  } catch {
    return false;
  }
}

export type Step = Record<string, unknown> | Ending | 'started';

/**
 * The next request once the one before it is answered, in order: initialize
 * (the expected Codex), the account (the ChatGPT plan's), its usage (the
 * guard), the thread, then the turn, started only inside the send deadline.
 */
export function nextStep(
  id: unknown,
  result: Record<string, unknown> | undefined,
  plan: Plan,
): Step {
  switch (id) {
    case 1:
      return expectedCodex(result, plan)
        ? { id: 2, method: 'account/read', params: {} }
        : refused('LOCAL_GPT_FAILED');
    case 2:
      return record(result?.['account'])?.['type'] === 'chatgpt'
        ? { id: 3, method: 'account/rateLimits/read' }
        : refused('GPT_SIGNED_OUT');
    case 3: {
      const stop = usageRefusal(result);
      if (stop !== null) return { result: stop, kill: true };
      const params = { model: plan.model, cwd: plan.cwd, ephemeral: true };
      return {
        id: 4,
        method: 'thread/start',
        params: { ...params, sandbox: 'read-only', approvalPolicy: 'never' },
      };
    }
    case 4: {
      const threadId = record(result?.['thread'])?.['id'];
      if (typeof threadId !== 'string') return broken(false);
      // The prompt leaves the machine with the turn: past the deadline, it never does.
      if (plan.sendBy !== null && Date.now() > plan.sendBy) return refused('SEND_LAPSED');
      const input = [{ type: 'text', text: plan.prompt }];
      return { id: 5, method: 'turn/start', params: { threadId, input, effort: 'low' } };
    }
    case 5:
      return 'started';
    default:
      return broken(false);
  }
}
