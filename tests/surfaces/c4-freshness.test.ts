// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429), CS-1.1: the header freshness marker is an indicator only, in one
// of five honest states (docs/design-system/research/LIVE-SYNC.md, "What the
// freshness marker shows"), and never claims anything on a denied re-read.
// `freshnessOf` decides the state and its words' values; the kit's
// `FreshnessMarker` (SL03, DS-PRIM-25) draws them and has no press.

import { describe, expect, it } from 'vitest';
import { freshnessOf, GRACE_MS, type LiveStatus } from '../../packages/ui/src/state/freshness.ts';

const ZONE = 'Australia/Brisbane';
// 10:45 in Brisbane on 29 September.
const NOW = Date.parse('2026-09-29T00:45:00Z');
const at = (iso: string): number => Date.parse(iso);

const healthy: LiveStatus = {
  denied: false,
  frozenAt: null,
  online: true,
  streamDownSince: null,
  failingSince: null,
  lastReadAt: at('2026-09-29T00:42:00Z'),
  changedAt: at('2026-09-29T00:43:00Z'),
  source: null,
};

const said = (status: Partial<LiveStatus>) => freshnessOf({ ...healthy, ...status }, NOW, ZONE);

describe('C4 CS-1.1 the freshness marker reports live, with the age of the newest change', () => {
  it('a healthy stream and a good read are live, aged from the newest change in scope', () => {
    expect(said({})).toEqual({ state: 'live', age: '2 min ago' });
    expect(said({ changedAt: at('2026-09-29T00:44:40Z') })).toEqual({
      state: 'live',
      age: 'just now',
    });
    expect(said({ changedAt: at('2026-09-28T21:40:00Z') })).toEqual({
      state: 'live',
      age: '3 h ago',
    });
  });

  it('with no change in scope, the age is the read’s own', () => {
    expect(said({ changedAt: null })).toEqual({ state: 'live', age: '3 min ago' });
  });
});

describe('C4 CS-1.1 the freshness marker says catching up, never current, while the stream is down', () => {
  it('a stream dropped moments ago, or down a while with reads on the floor, is catching up', () => {
    expect(said({ streamDownSince: NOW - 5_000 })).toEqual({
      state: 'catching-up',
      lastRead: '10:42',
    });
    expect(said({ streamDownSince: NOW - 10 * 60_000 })).toEqual({
      state: 'catching-up',
      lastRead: '10:42',
    });
  });

  it('reads failing within the grace are catching up; past it, offline', () => {
    expect(said({ failingSince: NOW - GRACE_MS + 1 })).toEqual({
      state: 'catching-up',
      lastRead: '10:42',
    });
    expect(said({ failingSince: NOW - GRACE_MS })).toEqual({ state: 'offline', lastRead: '10:42' });
  });

  it('the browser offline is offline at once, dated by the last read in the reader’s zone', () => {
    expect(said({ online: false })).toEqual({ state: 'offline', lastRead: '10:42' });
    expect(said({ online: false, lastReadAt: at('2026-09-27T20:10:00Z') })).toEqual({
      state: 'offline',
      lastRead: '28 Sep 06:10',
    });
  });
});

describe('C4 CS-1.1 the freshness marker is never green over a failing source', () => {
  const behind = { name: 'Search Console', lastGood: at('2026-09-28T20:10:00Z'), href: '/c/sc' };

  it('a source past its cadence is named with its last good time and its row', () => {
    expect(said({ source: { ...behind, behind: true } })).toEqual({
      state: 'source-behind',
      source: 'Search Console',
      lastGood: '06:10',
      href: '/c/sc',
    });
    expect(said({ source: { ...behind, behind: false } })).toMatchObject({ state: 'live' });
  });

  it('our own connection comes first: offline or catching up over a source behind', () => {
    const source = { ...behind, behind: true };
    expect(said({ source, online: false })).toMatchObject({ state: 'offline' });
    expect(said({ source, streamDownSince: NOW - 1_000 })).toMatchObject({ state: 'catching-up' });
  });
});

describe('C4 CS-1.1 a frozen page says so, and a denied or unread one claims nothing', () => {
  it('a frozen snapshot is frozen whatever its stream, dated in the reader’s zone', () => {
    expect(said({ frozenAt: at('2026-09-26T20:10:00Z'), online: false })).toEqual({
      state: 'frozen',
      at: 'Sunday 6:10am',
    });
  });

  it('a refused re-read, or no read yet, claims nothing', () => {
    // The control: the same page, allowed and read, does claim something.
    expect(said({})).not.toBeNull();
    expect(said({ denied: true })).toBeNull();
    expect(said({ denied: true, frozenAt: at('2026-09-26T20:10:00Z') })).toBeNull();
    expect(said({ lastReadAt: null, changedAt: null })).toBeNull();
    expect(said({ lastReadAt: null, online: false })).toBeNull();
  });
});
