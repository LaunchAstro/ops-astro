// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation at its own address, `/agent/:conversation` (C36, CS-7.38).
// The mockup has no page for it: the conversation it opens is the one the
// Client intelligence panel draws (DOCK T-16, MP-7-11), so each message is
// held to that panel's message in the mockup. The app draws the made-up
// conversation (made-up-agent.ts).

import type { LookProbe, LookScreen } from './probe.ts';

const MOCK = { path: '/agency/projects/' } as const;
const APP = { page: 'agency:agent-conversation' } as const;
const ALL = [1480, 900, 390] as const;
const BUBBLE: readonly string[] = [
  'font-family',
  'font-size',
  'line-height',
  'padding-top',
  'padding-left',
  'background-color',
  'color',
];

const probe = (
  id: string,
  selector: { readonly mockup: string; readonly app: string },
  props: readonly string[],
): LookProbe => ({
  id: `conversation.${id}`,
  mockup: { ...MOCK, selector: selector.mockup },
  app: { ...APP, selector: selector.app },
  props,
  widths: ALL,
  ruled: LEADING,
});

// MP-1-4: a message is DS-TOK-117 --type-body (14/1.55); the panel's
// .875rem/1.5 is drift off the type scale.
const LEADING = (['light', 'dark'] as const).map((theme) => ({
  at: `line-height@${theme}`,
  want: '21.7px',
  why: 'MP-1-4',
}));

export const CONVERSATION: LookScreen = {
  id: 'conversation',
  probes: [
    probe(
      'agent-message',
      { mockup: '.aip__msg.aip__msg--ai:not(.aip__msg--note)', app: '.convrec__msg--agent' },
      [...BUBBLE, 'border-top-color', 'border-top-width'],
    ),
    probe(
      'person-message',
      { mockup: '.aip__msg.aip__msg--user', app: '.convrec__msg--person' },
      BUBBLE,
    ),
  ],
};
