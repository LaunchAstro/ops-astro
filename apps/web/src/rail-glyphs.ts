// SPDX-License-Identifier: AGPL-3.0-only
//
// Each rail section's own glyph (MP-2-2; SIDEBAR.md T-R4, DS-SIDE-D1). The
// mockup keyed its rail icons by legacy address (`portal.js` RAIL_ICONS), so a
// folded rail on a canonical address drew blank hit areas. Here they are keyed
// by section, taken from the mockup's map where it names the section's page
// and chosen from the licensed set (MP-1-2) where it names none, distinct
// within each face. The rail draws them only once it folds (MP-2-3).

import type { GlyphName } from '@launchastro/ui';

/** Keyed `namespace:section`, as the rail's entries are. */
export const RAIL_GLYPHS: Readonly<Record<string, GlyphName>> = {
  'agency:dashboard': 'apps',
  'agency:inbox': 'bell',
  'agency:projects': 'briefcase',
  'agency:clients': 'users',
  'agency:connections': 'plug',
  'agency:general': 'settings-sliders',
  'clients:brief': 'document',
  'clients:projects': 'briefcase',
  'clients:connections': 'settings-sliders',
  'clients:brand': 'folder',
  'clients:docs': 'file-edit',
  'clients:forms': 'list-check',
  'clients:invoices': 'user',
  'portal:home': 'home',
  'portal:weekly-report': 'stats',
  'portal:projects': 'briefcase',
  'portal:brand': 'folder',
  'portal:invoices': 'user',
  'portal:contact': 'envelope',
};
