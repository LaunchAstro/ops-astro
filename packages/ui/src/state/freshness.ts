// SPDX-License-Identifier: AGPL-3.0-only
//
// C4: what the page header's freshness marker says. Stub for the red run.

export type Freshness =
  | { readonly state: 'live'; readonly age: string }
  | { readonly state: 'catching-up'; readonly lastRead: string }
  | { readonly state: 'offline'; readonly lastRead: string }
  | {
      readonly state: 'source-behind';
      readonly source: string;
      readonly lastGood: string;
      readonly href: string;
    }
  | { readonly state: 'frozen'; readonly at: string };

export interface LiveStatus {
  readonly denied: boolean;
  readonly frozenAt: number | null;
  readonly online: boolean;
  readonly streamDownSince: number | null;
  readonly failingSince: number | null;
  readonly lastReadAt: number | null;
  readonly changedAt: number | null;
  readonly source: {
    readonly name: string;
    readonly lastGood: number;
    readonly href: string;
    readonly behind: boolean;
  } | null;
}

export const GRACE_MS = 30_000;

export function freshnessOf(
  _status: LiveStatus,
  _now: number,
  _timeZone: string,
): Freshness | null {
  return null;
}
