// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for the wayfinder map's reads (WF-1 to WF-4, API-4), beside
// `made-up-api.ts`, which spreads them into its set. The map page at the
// harness's `/map/:key` draws a map with every section filled, tickets that
// block one another, and a frontier, so its captures show rows, not the
// "could not be read" state. Typed against the wire contract; every name,
// client and decision here is made up. The look itself waits on prototype W4
// (#603): these answers make the page drawable, they do not match it.
import type {
  MapFrontierResult,
  MapStatusResult,
  MapView,
  MapViewResult,
  TicketContextResult,
} from '../../packages/core-wire/src/index.ts';

const id = (n: number): string => `00000000-0000-4000-8000-00000000a${String(n).padStart(3, '0')}`;
const NATHAN = 'p-nathan';

const TICKETS = [
  { n: 41, title: 'Pick the booking widget the clinics already pay for', state: 'Done' },
  { n: 42, title: 'Draft the service pages from the intake answers', state: 'Active' },
  { n: 43, title: 'Move the old blog posts across with their addresses', state: 'Active' },
  { n: 44, title: 'Launch checklist and the redirect map', state: 'Waiting on client' },
] as const;

const MAP: MapView = {
  id: id(40),
  key: 'T-40',
  title: 'Meridian Physio website rebuild',
  type: 'map',
  owner: NATHAN,
  client: 'Meridian Physio',
  version: 3,
  revision: 5,
  destination: {
    id: id(1),
    kind: 'destination',
    text: 'A new site for the three clinics that books a first visit in two taps, live by 1 November.',
    ticketId: null,
  },
  notes: {
    id: id(2),
    kind: 'notes',
    text: 'The clinic owner signs off copy; the practice manager owns the booking system login.',
    ticketId: null,
  },
  fog: [
    {
      id: id(3),
      kind: 'fog',
      text: 'Whether the Kirwan clinic keeps its own page',
      ticketId: null,
    },
    { id: id(4), kind: 'fog', text: 'Which reviews the clinic may quote', ticketId: null },
  ],
  outOfScope: [
    { id: id(5), kind: 'out_of_scope', text: 'A patient portal', ticketId: id(45) },
    { id: id(6), kind: 'out_of_scope', text: 'Paid search for the launch', ticketId: null },
  ],
  preAnswers: [
    {
      id: id(7),
      question: 'Which booking system?',
      answer: 'The one the clinics already pay for; no new subscription.',
      vetoOpen: true,
      source: { recordId: id(41), key: 'T-41' },
    },
    {
      id: id(8),
      question: 'Keep the old addresses?',
      answer: 'Yes, every indexed address redirects.',
      vetoOpen: false,
      source: { reference: 'Kick-off call notes, 12 September' },
    },
  ],
  decisions: [
    {
      ticketId: id(41),
      key: 'T-41',
      title: TICKETS[0].title,
      gist: 'Keep the current booking system and embed it.',
      closedAt: '2026-09-22T02:00:00.000Z',
    },
  ],
  tickets: TICKETS.map((ticket, i) => ({
    id: id(ticket.n),
    key: `T-${String(ticket.n)}`,
    title: ticket.title,
    type: 'ticket',
    state: ticket.state,
    revision: 1,
    // The launch waits on the pages and the posts; the pages on the widget.
    blockedBy: i === 3 ? [id(42), id(43)] : i === 1 ? [id(41)] : [],
  })),
  versions: [
    { version: 1, changed: ['destination'], actorId: NATHAN, at: '2026-09-12T01:00:00.000Z' },
    { version: 2, changed: ['fog', 'notes'], actorId: NATHAN, at: '2026-09-18T03:30:00.000Z' },
    { version: 3, changed: ['out_of_scope'], actorId: NATHAN, at: '2026-09-24T22:15:00.000Z' },
  ],
};

const frontier = MAP.tickets
  .filter((ticket) => ticket.state === 'Active')
  .map(({ id: ticketId, key, title, type }) => ({ id: ticketId, key, title, type }));
const fog = MAP.fog.map(({ id: fogId, text }) => ({ id: fogId, text }));

/** The four wayfinder reads, answered from the one made-up map. */
export const WAYFINDER_READS: {
  readonly 'map.view': MapViewResult;
  readonly 'map.frontier': MapFrontierResult;
  readonly 'map.status': MapStatusResult;
  readonly 'task.context': TicketContextResult;
} = {
  'map.view': { ok: true, map: MAP } satisfies MapViewResult,
  'map.frontier': { ok: true, frontier, fog } satisfies MapFrontierResult,
  'map.status': {
    ok: true,
    detail: 'standard',
    status: { map: id(40), version: 3, open: 3, closed: 1, outOfScope: 2, frontier, fog },
  } satisfies MapStatusResult,
  'task.context': {
    ok: true,
    detail: 'full',
    context: {
      ticket: { id: id(44), key: 'T-44', title: TICKETS[3].title, state: TICKETS[3].state },
      map: { id: id(40), key: 'T-40', title: MAP.title, decisions: MAP.decisions },
      blockedBy: [
        { id: id(42), key: 'T-42', title: TICKETS[1].title },
        { id: id(43), key: 'T-43', title: TICKETS[2].title },
      ],
      blocks: [],
      acceptance: ['Every old address answers with a redirect', 'Booking opens from every page'],
      documents: [],
      thread: [],
      threadCount: 0,
    },
  } satisfies TicketContextResult,
};
