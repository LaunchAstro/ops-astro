// SPDX-License-Identifier: AGPL-3.0-only
//
// A carriage (`packages/core-custody/src/carriage.ts`) in memory, for the
// model agent's own cases: topics are names, a join is admitted or refused by
// the case, and a message reaches every other line joined to its topic a turn
// later, never the line that sent it (Realtime's `self: false`). A case can
// look at, drop or copy any message on its way (`tap`). It proves nothing of
// hosted policy; the database's join function and the hub do that.

import type { Carriage, Line } from '../../packages/core-custody/src/agent.ts';

type Listener = (event: string, message: unknown) => void;

interface Joined {
  readonly topic: string;
  readonly token: string;
  readonly listeners: Set<Listener>;
}

export interface Said {
  readonly topic: string;
  readonly event: string;
  readonly message: unknown;
}

export interface MemoryCarriage extends Carriage {
  /** Every message sent, in order, by any line. */
  readonly said: Said[];
  /** Whether a join of `topic` with `token` is admitted; every one is unless a case says. */
  admit: (topic: string, token: string) => boolean;
  /** Each message on its way: answer false to drop it. */
  tap: (said: Said) => boolean;
  /** The topics joined now, one entry per open line. */
  joined(): readonly string[];
  /** Resolves once a message for which `wanted` holds has been sent, `n` of them in all. */
  until(wanted: (said: Said) => boolean, n?: number): Promise<readonly Said[]>;
}

/** A joined line: what it sends reaches the topic's other lines a turn later, if the tap lets it. */
function lineOf(
  self: Joined,
  lines: Set<Joined>,
  carriage: MemoryCarriage,
  waits: Set<() => void>,
): Line {
  return {
    send: async (event, message) => {
      const said = { topic: self.topic, event, message };
      carriage.said.push(said);
      for (const check of waits) check();
      if (!lines.has(self)) return 'failed';
      if (carriage.tap(said)) {
        const others = [...lines].filter((other) => other !== self && other.topic === self.topic);
        setImmediate(() => {
          for (const other of others)
            for (const listener of other.listeners) listener(event, message);
        });
      }
      return await Promise.resolve('sent');
    },
    hear: (listener) => {
      self.listeners.add(listener);
      return () => self.listeners.delete(listener);
    },
    leave: async () => {
      lines.delete(self);
      await Promise.resolve();
    },
  };
}

export function memoryCarriage(): MemoryCarriage {
  const lines = new Set<Joined>();
  const waits = new Set<() => void>();
  const carriage: MemoryCarriage = {
    said: [],
    admit: () => true,
    tap: () => true,
    joined: () => [...lines].map((line) => line.topic),
    until: async (wanted, n = 1) =>
      await new Promise((resolve) => {
        const check = (): void => {
          const found = carriage.said.filter((said) => wanted(said));
          if (found.length < n) return;
          waits.delete(check);
          resolve(found);
        };
        waits.add(check);
        check();
      }),
    join: async (topic, token) => {
      await Promise.resolve();
      if (!carriage.admit(topic, token)) return { ok: false, code: 'CARRIAGE_UNAVAILABLE' };
      const self: Joined = { topic, token, listeners: new Set() };
      lines.add(self);
      return { ok: true, line: lineOf(self, lines, carriage, waits) };
    },
  };
  return carriage;
}
