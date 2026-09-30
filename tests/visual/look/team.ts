// SPDX-License-Identifier: AGPL-3.0-only
//
// SL10, Team (MP-7-10, DOCK "Team panel", TM-01 to 06): the people strip on
// `/team`, held to the mockup's dock Team panel, opened by its tab. The face
// is the kit's large avatar, so only its size is compared (the kit owns its
// look); the strip's spacing and the name's type are the panel's own. At 900
// and 390 the mockup's page covers the dock tab, so this is 1480 in both
// themes; the harness captures hold the narrow widths.

import type { LookScreen } from './index.ts';

const PANEL = { path: '/agency/projects/', open: '[data-dock-tab="team"]' } as const;
const APP = { page: 'agency:team' } as const;

export const TEAM: LookScreen = {
  id: 'team',
  probes: [
    {
      id: 'team.strip',
      mockup: { ...PANEL, selector: '.tmc__strip' },
      app: { ...APP, selector: '.tmc__strip' },
      props: ['column-gap', 'padding-bottom', 'border-bottom-color', 'border-bottom-width'],
    },
    {
      id: 'team.person',
      mockup: { ...PANEL, selector: '.tmc__p' },
      app: { ...APP, selector: '.tmc__p' },
      props: ['row-gap', 'padding-top', 'align-items'],
    },
    {
      id: 'team.face',
      mockup: { ...PANEL, selector: '.tmc__av' },
      app: { ...APP, selector: '.tmc__face > *' },
      props: ['box.width', 'box.height'],
    },
    {
      id: 'team.name',
      mockup: { ...PANEL, selector: '.tmc__p:not(.is-on) .tmc__n' },
      app: { ...APP, selector: '.tmc__p:not(.is-on) .tmc__n' },
      props: ['font-family', 'font-size', 'color'],
      // 11px folds to --type-caption, 12px (TOKENS.md row 9, "drift, drop").
      ruled: [
        { at: 'font-size@light', want: '12px', why: 'DS-TOK-122' },
        { at: 'font-size@dark', want: '12px', why: 'DS-TOK-122' },
      ],
    },
  ],
};
