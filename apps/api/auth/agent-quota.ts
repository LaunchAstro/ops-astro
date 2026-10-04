// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential's quota (API-2): requests a minute, calls in flight
// and records handed out a minute, each held per credential, per person and
// per business; and the made-up or dead bearers a business key is sent a
// minute, past which a not-live one is answered as limited and not recorded.
//
// Past a full door each bearer costs one unlocked read and writes nothing
// (`executeCredentialCommand`); nothing here holds a bearer, its digest or a
// client's address, so a live credential is never refused at the door. The
// platform's own request limit stands in front of that read.

import type { CredentialQuota, QuotaSlot } from '../../../packages/core-commands/src/index.ts';

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

/**
 * A business's door: its not-live bearers a minute, counted in its own
 * window's `requests`. A knock takes a place at once; a released one is given
 * back to the window it was taken from.
 */
function doorOf(refused: number, now: () => Date): Pick<CredentialQuota, 'knock'> {
  const windows = new Map<string, Window>();
  return {
    knock(businessId) {
      const window = currentWindow(windows, businessId, now().getTime());
      if (window.requests >= refused) return;
      window.requests += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          window.requests -= 1;
        },
      };
    },
  };
}

/**
 * The quota as the app holds it, in this process: a fixed one-minute window
 * of requests and records handed out, and a count of calls in flight, per
 * level. A call is refused when any level is at any of its limits, before it
 * runs, and counts only when it is let in. Its records count when its answer
 * is decided, and an answer that would take a level past its limit is
 * refused then, so calls let in together cannot hand out more between them.
 * `handedOut` is the app's own count of the records an answer carries.
 */
export function createAgentQuota(
  limits: AgentLimits,
  now: () => Date,
  handedOut: (answer: object) => number,
): CredentialQuota {
  return {
    ...doorOf(limits.refused, now),
    ...callsOf(limits, now, handedOut),
  };
}

/** What a call's slot needs from the quota that let it in. */
interface Counts {
  readonly limits: AgentLimits;
  readonly now: () => Date;
  readonly handedOut: (answer: object) => number;
  readonly windowOf: (key: string, at: number) => Window;
  readonly inFlight: Map<string, number>;
}

type Level = (typeof LEVELS)[number];

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
      return slotOf(counted, { limits, now, handedOut, windowOf, inFlight });
    },
  };
}

/** A call let in: its records counted when its answer is decided, its place given back as it leaves. */
function slotOf(
  counted: readonly { readonly level: Level; readonly key: string }[],
  { limits, now, handedOut, windowOf, inFlight }: Counts,
): QuotaSlot {
  let left = false;
  // What this call has counted, in the windows it counted it in.
  let held: { readonly windows: readonly Window[]; readonly items: number } | undefined;
  const giveBack = (): void => {
    for (const window of held?.windows ?? []) window.exports -= held?.items ?? 0;
    held = undefined;
  };
  return {
    handOut(answer) {
      giveBack();
      const items = handedOut(answer);
      const at = now().getTime();
      const open = counted.map(({ level, key }) => ({ level, window: windowOf(key, at) }));
      if (open.some(({ level, window }) => window.exports + items > limits.exports[level])) {
        return false;
      }
      for (const { window } of open) window.exports += items;
      held = { windows: open.map(({ window }) => window), items };
      return true;
    },
    leave(delivered) {
      if (left) return;
      left = true;
      if (!delivered) giveBack();
      for (const { key } of counted) {
        const running = (inFlight.get(key) ?? 1) - 1;
        if (running > 0) inFlight.set(key, running);
        else inFlight.delete(key);
      }
    },
  };
}
