// SPDX-License-Identifier: AGPL-3.0-only
//
// The route registry is the router (thermo review M12).
//
// Every authenticated route has a screen, no public route has one, and every
// address the application writes comes out of `pathTo` in the same form the
// matcher resolves.

import { describe, expect, it } from 'vitest';
import { ROUTES, matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { PANELS } from '../../apps/web/src/panels.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';

// Never called: each is a type error. A route's parameters are read off its
// path, so a missing key or a stray one does not compile rather than throwing.
const missing = (): string =>
  // @ts-expect-error agency:task-detail needs its key
  pathTo('agency:task-detail');
const extra = (): string =>
  // @ts-expect-error agency:settings takes no parameters
  pathTo('agency:settings', { key: 'TSK-1' });

describe('the route registry', () => {
  it('has a screen for every authenticated route and none for a public one', () => {
    const authenticated = Object.entries(ROUTES)
      .filter(([, route]) => route.authenticated)
      .map(([id]) => id);
    expect(Object.keys(SCREENS).toSorted()).toEqual(authenticated.toSorted());
  });

  it('spells each address the way it always has, and the matcher resolves it', () => {
    expect(pathTo('agency:sign-in')).toBe('/sign-in');
    expect(pathTo('agency:projects-board')).toBe('/projects/');
    expect(pathTo('agency:settings')).toBe('/settings');
    expect(pathTo('agency:task-detail', { key: 'TSK 1/2' })).toBe('/task/TSK%201%2F2');
    expect(matchRoute(pathTo('agency:task-detail', { key: 'TSK 1/2' }))?.params).toEqual({
      key: 'TSK 1/2',
    });
  });

  it('refuses to build an address with a parameter missing, at compile time', () => {
    expect([missing, extra]).toHaveLength(2);
  });

  it('points every panel at a route the registry serves', () => {
    for (const panel of PANELS) {
      if (panel.route === null) continue;
      expect(matchRoute(pathTo(panel.route))?.id).toBe(panel.route);
    }
  });
});
