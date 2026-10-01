// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential's quota (API-2): requests a minute, calls in flight
// and records handed out a minute, each held per credential, per person and
// per business; and the made-up or dead bearers a business key is sent a
// minute, past which a not-live one is answered as limited and not recorded.
//
// With the door full, a bearer is answered as limited before any transaction
// when it was answered not live this window, or when its address has sent the
// business its share (`refused`) of not-live bearers this window, unless it
// has been served live since the process started. So past the door each
// made-up bearer costs a lookup only from an address under its share. The
// address is the server's socket. The Vercel function trusts no client-address
// header (the repo trusts none), so there only the not-live digests and the
// platform's own request limit stand in front of the lookup. The held bearers
// are digests, never the secrets.

import { createHash } from 'node:crypto';
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
  /** Not-live bearers a minute, per business, recorded before the rest are answered as limited. */
  readonly refused: number;
}

/** The installation's limits unless a deployment names its own. */
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  requests: { credential: 120, person: 240, business: 600 },
  concurrent: { credential: 4, person: 8, business: 16 },
  exports: { credential: 2000, person: 4000, business: 10_000 },
  refused: 60,
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

/** A business's door: its not-live bearers a minute, counted in its own window's `requests`. */
function doorOf(refused: number, now: () => Date): Pick<CredentialQuota, 'knock' | 'turnedAway'> {
  const windows = new Map<string, Window>();
  const door = (businessId: string): Window => currentWindow(windows, businessId, now().getTime());
  return {
    knock: (businessId) => door(businessId).requests < refused,
    turnedAway(businessId) {
      door(businessId).requests += 1;
    },
  };
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
  return {
    ...doorOf(limits.refused, now),
    ...screenOf(limits.refused, now),
    ...callsOf(limits, now, handedOut),
  };
}

const LIVE_HELD = 10_000;
const digestOf = (credential: string): string =>
  createHash('sha256').update(credential, 'utf8').digest('hex');

/** The bearers past a full door: digests answered not live, addresses' counts, digests served live. */
function screenOf(refused: number, now: () => Date): Pick<CredentialQuota, 'screen' | 'resolved'> {
  const dead = new Map<string, Window>();
  const addresses = new Map<string, Window>();
  const live = new Set<string>();
  const running = (windows: Map<string, Window>, key: string): Window | undefined => {
    const held = windows.get(key);
    return held !== undefined && now().getTime() - held.start < WINDOW_MS ? held : undefined;
  };
  return {
    screen(businessId, credential, address) {
      const digest = digestOf(credential);
      if (running(dead, `${businessId}:${digest}`) !== undefined) return true;
      if (address === undefined || live.has(digest)) return false;
      return (running(addresses, `${businessId}:${address}`)?.requests ?? 0) >= refused;
    },
    resolved(businessId, credential, address, served) {
      const digest = digestOf(credential);
      if (served) {
        dead.delete(`${businessId}:${digest}`);
        live.delete(digest);
        live.add(digest);
        // The longest unseen goes first, so the set cannot grow without end.
        if (live.size > LIVE_HELD) live.delete(live.values().next().value ?? '');
        return;
      }
      currentWindow(dead, `${businessId}:${digest}`, now().getTime());
      if (address !== undefined) {
        currentWindow(addresses, `${businessId}:${address}`, now().getTime()).requests += 1;
      }
    },
  };
}

/** The three levels' counts; `createAgentQuota` adds the door. */
function callsOf(
  limits: AgentLimits,
  now: () => Date,
  handedOut: (answer: object) => number,
): Pick<CredentialQuota, 'enter'> {
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
