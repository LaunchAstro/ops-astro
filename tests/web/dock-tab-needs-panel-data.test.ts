// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { dockTabs, type PanelRegistry } from '../../apps/web/src/panels.ts';

it('a route with no panel data does not register a tab', () => {
  const registry: PanelRegistry = {
    ai: { label: 'AI', ariaLabel: 'AI', route: 'agency:sign-in' },
  };

  expect(dockTabs({}, registry)).toEqual([]);
});
