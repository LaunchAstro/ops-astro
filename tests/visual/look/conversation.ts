// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation page, `/agent/:conversation` (C36, CS-7.38). The mockup
// has no page at this address; the transcript is the drawer's transcript at
// its own address, so its messages are held to the drawer's (DOCK AI-09):
// one message look, not a second one for the page.

import type { LookProbe, LookScreen } from './index.ts';

// The mockup side is the drawer, which opens at 1480 only (agent-drawer.ts).
const WIDTHS = [1480] as const;
const MOCKUP = { path: '/agency/projects/', open: '[data-dock-tab="ai"]' } as const;
const APP = { page: 'agency:agent-conversation' } as const;

const message = (id: string, mockup: string, app: string): LookProbe => ({
  id: `conversation.${id}`,
  mockup: { ...MOCKUP, selector: mockup },
  app: { ...APP, selector: app },
  props: [
    'font-family',
    'font-size',
    'line-height',
    'color',
    'background-color',
    'border-top-width',
    'padding-top',
    'padding-left',
  ],
  widths: WIDTHS,
  // DR-14: one reading line height, 1.55 (--leading-normal); the mockup drew 1.5.
  ruled: [
    { at: 'line-height@light', want: '21.7px', why: 'DR-14' },
    { at: 'line-height@dark', want: '21.7px', why: 'DR-14' },
  ],
});

export const CONVERSATION: LookScreen = {
  id: 'conversation',
  probes: [
    message('agent-message', '.aip__msg--ai', '.convrec__msg--agent'),
    message('person-message', '.aip__msg--user', '.convrec__msg--person'),
  ],
};
