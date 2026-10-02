// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus review r of c-prefs (SL06-6), note 1: the tab's copy of a person's
// layout (`ops-astro.layout.<business>`, rail and dock sizes) is removed when
// the tab leaves that business, by a held-address switch or by sign-out, as
// the dock's open set is (dock-sign-out-after-business-switch.test.tsx).

import { describe, expect, it } from 'vitest';
import { SessionStore, layoutKey } from '../../apps/web/src/session/token.ts';
import { storage } from './mp-2-1-support.tsx';

const ALPHA = { businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 's-1' };
const BRAVO = { businessKey: 'bravo', email: 'mia@alpha.local', sessionId: 's-1' };
const KEPT = JSON.stringify({ who: 'mia@alpha.local', 'rail.width': 240, 'rail.collapsed': false });

describe('MP-2-11 the tab keeps no layout of a business it left', () => {
  it('a switch to another business removes the layout row of the business it leaves', () => {
    const tab = storage({ [layoutKey('alpha')]: KEPT });
    const sessions = new SessionStore(tab.like);
    sessions.set(ALPHA);
    sessions.set(BRAVO);
    expect(tab.held.has(layoutKey('alpha'))).toBe(false);
  });

  it('sign-out removes the layout row of the business it ends in', () => {
    const tab = storage({ [layoutKey('bravo')]: KEPT });
    const sessions = new SessionStore(tab.like);
    sessions.set(BRAVO);
    sessions.clear();
    expect(tab.held.has(layoutKey('bravo'))).toBe(false);
  });

  it('staying in the same business keeps the row', () => {
    const tab = storage({ [layoutKey('alpha')]: KEPT });
    const sessions = new SessionStore(tab.like);
    sessions.set(ALPHA);
    sessions.set({ ...ALPHA, sessionId: 's-2' });
    expect(tab.held.get(layoutKey('alpha'))).toBe(KEPT);
  });
});
