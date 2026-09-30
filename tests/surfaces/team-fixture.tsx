// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel tests' one team: four people, one of them the reader and one
// away, their direct conversations, and the panel's props with every call kept.

import type {
  AvailabilityChange,
  DirectThread,
  GroupAction,
  GroupThread,
  OpenHow,
  TeamMessage,
  TeamPanelProps,
  Teammate,
} from '../../packages/ui/src/index.ts';
import type { Mounted } from './mount.tsx';

export const person = (personId: string, name: string, away: string | null = null): Teammate => ({
  personId,
  name,
  short: name.split(' ')[0] ?? name,
  initials: name
    .split(' ')
    .map((part) => part[0])
    .join(''),
  away: away === null ? null : { reason: away },
});

/** Away with no reason: the command allows it (another client may set it), this panel never sends it. */
export const unsaid = (personId: string, name: string): Teammate => ({
  ...person(personId, name),
  away: { reason: null },
});

export const ME = 'p-me';
export const PEOPLE: readonly Teammate[] = [
  person('p-remy', 'Remy Hale'),
  person(ME, 'Sam Reid'),
  person('p-len', 'Len Ortiz', 'At the Meridian shoot until 2'),
  person('p-cath', 'Cath Lea'),
];

export const message = (
  id: string,
  authorId: string,
  at: string,
  body = `Message ${id}`,
): TeamMessage => ({
  id,
  authorId,
  author: PEOPLE.find((p) => p.personId === authorId)?.name ?? authorId,
  at,
  body,
});

/** Remy: read to 09:40, one of his after it. Len: nothing unread. Cath: never read, two of hers. */
export const THREADS: readonly DirectThread[] = [
  {
    with: 'p-remy',
    lastRead: '2026-09-28T09:40:00Z',
    messages: [
      message('r1', 'p-remy', '2026-09-28T09:12:00Z'),
      message('r2', ME, '2026-09-28T09:31:00Z'),
      message('r3', 'p-remy', '2026-09-28T11:47:00Z'),
    ],
  },
  {
    with: 'p-len',
    lastRead: '2026-09-28T10:05:00Z',
    messages: [
      message('l1', 'p-len', '2026-09-28T08:55:00Z'),
      message('l2', ME, '2026-09-28T10:02:00Z'),
    ],
  },
  {
    with: 'p-cath',
    lastRead: null,
    messages: [
      message('c1', 'p-cath', '2026-09-28T08:20:00Z'),
      message('c2', 'p-cath', '2026-09-28T08:21:00Z'),
    ],
  },
];

export interface Calls {
  readonly work: [string, OpenHow][];
  readonly availability: AvailabilityChange[];
  readonly marks: [string, string][];
  readonly sends: [string, string][];
  readonly groups: GroupAction[];
}

/** What a test may put in place of the fixture's own: any prop, or a whole capability left out. */
export type Over = Partial<TeamPanelProps> & {
  readonly work?: null;
  readonly conversations?: null;
};

export function props(over: Over = {}): TeamPanelProps & { readonly calls: Calls } {
  const calls: Calls = { work: [], availability: [], marks: [], sends: [], groups: [] };
  return {
    people: PEOPLE,
    me: ME,
    workHref: (id) => `/projects/?person=${id}`,
    onOpenWork: (id, how) => calls.work.push([id, how]),
    onSetAvailability: (change) => calls.availability.push(change),
    threads: [],
    onMarkRead: (withPerson, upTo) => calls.marks.push([withPerson, upTo]),
    onSend: (to, body) => calls.sends.push([to, body]),
    groups: [],
    onGroup: (action) => calls.groups.push(action),
    ...over,
    calls,
  };
}

export const chip = (m: Mounted, id: string): Element | null =>
  m.host.querySelector(`[data-person="${id}"]`);

/** Launch: Remy, Cath and the reader; read to 10:00, one of Cath's after it. The reader started it. */
export const LAUNCH: GroupThread = {
  id: 'g-launch',
  name: 'Meridian launch',
  members: ['p-remy', ME, 'p-cath'],
  canManage: true,
  lastRead: '2026-09-28T10:00:00Z',
  messages: [
    message('g1', 'p-remy', '2026-09-28T09:50:00Z'),
    message('g2', 'p-cath', '2026-09-28T10:20:00Z', 'Proofs are up'),
  ],
};

/** Studio: Len started it, the reader cannot manage it; nothing unread. */
export const STUDIO: GroupThread = {
  id: 'g-studio',
  name: 'Studio',
  members: ['p-len', ME, 'p-remy'],
  canManage: false,
  lastRead: '2026-09-28T09:00:00Z',
  messages: [message('s1', 'p-len', '2026-09-28T08:30:00Z')],
};
