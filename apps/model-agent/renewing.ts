// SPDX-License-Identifier: AGPL-3.0-only
//
// A carriage whose lines outlive the token they joined with: every `everyMs`
// each line joins its topic again with the login's current token, then leaves
// the old one. Both are heard meanwhile, so nothing is lost; a message heard
// twice the agent takes as any repeat.

import type { Carriage, Line } from '../../packages/core-custody/src/agent.ts';

type Listener = (event: string, message: unknown) => void;

export function renewing(
  carriage: Carriage,
  token: () => Promise<string>,
  everyMs: number,
): Carriage {
  return {
    join: async (topic, accessToken) => {
      const joined = await carriage.join(topic, accessToken);
      if (!joined.ok) return joined;
      const listeners = new Set<Listener>();
      let line = joined.line;
      let left = false;
      const take = (next: Line): void => {
        line = next;
        next.hear((event, message) => {
          for (const listener of listeners) listener(event, message);
        });
      };
      take(joined.line);
      const renew = async (): Promise<void> => {
        const next = await carriage.join(topic, await token());
        if (!next.ok) return;
        if (left) {
          await next.line.leave();
          return;
        }
        const old = line;
        take(next.line);
        await old.leave();
      };
      const timer = setInterval(() => void renew(), everyMs);
      timer.unref();
      return {
        ok: true,
        line: {
          send: async (event, message) => await line.send(event, message),
          hear: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          leave: async () => {
            left = true;
            clearInterval(timer);
            await line.leave();
          },
        },
      };
    },
  };
}
