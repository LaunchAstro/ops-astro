// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential's quota (API-2): requests a minute, calls in flight
// and records handed out a minute, each held per credential, per person and
// per business.

import type { CredentialQuota } from '../../../packages/core-commands/src/index.ts';

/** One limit at each of the three levels a credential's call counts against. */
export interface Tiers {
  readonly credential: number;
  readonly person: number;
  readonly business: number;
}

export interface AgentLimits {
  /** Calls a minute. */
  readonly requests: Tiers;
  /** Calls at once. */
  readonly concurrent: Tiers;
  /** Records handed out a minute. */
  readonly exports: Tiers;
}

/** The installation's limits unless a deployment names its own. */
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  requests: { credential: 120, person: 240, business: 600 },
  concurrent: { credential: 4, person: 8, business: 16 },
  exports: { credential: 2000, person: 4000, business: 10_000 },
};

const WINDOW_MS = 60_000;
const LEVELS = ['credential', 'person', 'business'] as const;

interface Window {
  start: number;
  requests: number;
  exports: number;
}

/** This key's window at `at`: the one running, or a fresh one. */
function currentWindow(windows: Map<string, Window>, key: string, at: number): Window {
  const held = windows.get(key);
  if (held !== undefined && at - held.start < WINDOW_MS) return held;
  // A new window; stale ones go when the map grows, so it cannot grow without end.
  if (windows.size > 10_000) {
    for (const [old, window] of windows) if (at - window.start >= WINDOW_MS) windows.delete(old);
  }
  const fresh = { start: at, requests: 0, exports: 0 };
  windows.set(key, fresh);
  return fresh;
}

/**
 * The quota as the app holds it, in this process: a fixed one-minute window
 * of requests and records handed out, and a count of calls in flight, per
 * level. A call is refused when any level is at any of its limits, before it
 * runs, and counts only when it is let in. `handedOut` is the app's own count
 * of the records an answer carries.
 */
export function createAgentQuota(
  limits: AgentLimits,
  now: () => Date,
  handedOut: (answer: object) => number,
): CredentialQuota {
  const windows = new Map<string, Window>();
  const inFlight = new Map<string, number>();
  const windowOf = (key: string, at: number): Window => currentWindow(windows, key, at);
  return {
    enter(keys) {
      const at = now().getTime();
      const named = {
        credential: `c:${keys.credentialId}`,
        person: `p:${keys.businessId}:${keys.personId}`,
        business: `b:${keys.businessId}`,
      };
      const counted = LEVELS.map((level) => ({
        level,
        key: named[level],
        window: windowOf(named[level], at),
        running: inFlight.get(named[level]) ?? 0,
      }));
      const full = counted.some(
        ({ level, window, running }) =>
          window.requests >= limits.requests[level] ||
          window.exports >= limits.exports[level] ||
          running >= limits.concurrent[level],
      );
      if (full) return;
      for (const one of counted) {
        one.window.requests += 1;
        inFlight.set(one.key, one.running + 1);
      }
      let left = false;
      return {
        leave(answer) {
          if (left) return;
          left = true;
          const items = answer === undefined ? 0 : handedOut(answer);
          for (const { key } of counted) {
            const running = (inFlight.get(key) ?? 1) - 1;
            if (running > 0) inFlight.set(key, running);
            else inFlight.delete(key);
            windowOf(key, now().getTime()).exports += items;
          }
        },
      };
    },
  };
}
