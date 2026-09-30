// SPDX-License-Identifier: AGPL-3.0-only
//
// B1, the shell and the left rail (SIDEBAR.md Part 2, DS-SIDE-11 to 13; PAGE-MAP SH-*).

import type { LookScreen } from './probe.ts';

const BOARD = { path: '/agency/projects/' } as const;
const APP = { page: 'agency:projects-board' } as const;

export const SHELL: LookScreen = {
  id: 'shell',
  probes: [
    {
      id: 'shell.rail',
      mockup: { ...BOARD, selector: 'nav.rail' },
      app: { ...APP, selector: 'nav.rail' },
      props: ['background-color', 'border-right-color', 'padding-top', 'box.width'],
    },
    {
      id: 'shell.rail-hub-label',
      mockup: { ...BOARD, selector: '.rail__hub' },
      app: { ...APP, selector: '.rail__hub' },
      props: [
        'font-family',
        'font-size',
        'font-weight',
        'letter-spacing',
        'text-transform',
        'color',
      ],
    },
    {
      id: 'shell.rail-item',
      mockup: { ...BOARD, selector: '.rail__group a.rail__item:not(.is-here)' },
      app: { ...APP, selector: '.rail__group a.rail__item:not([aria-current])' },
      props: ['font-family', 'font-size', 'color', 'padding-left', 'box.height'],
    },
  ],
};
