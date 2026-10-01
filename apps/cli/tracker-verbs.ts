// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder tracker's verbs (API-5, CS-15.20): the operations the
// upstream wayfinder and grilling skills send that API-3's general set does
// not already cover, each one row onto its owning wayfinder command, so every
// operation in `docs/agents/issue-tracker-ops-astro.md` is one CLI call. Like
// every verb, a row holds no rule: the command checks the grant, the map and
// the operands. List-shaped operands (fog lines, tickets) go as JSON lists.

import {
  idList,
  jsonList,
  maybe,
  need,
  optional,
  revision,
  target,
  type Body,
  type VerbRow,
} from './verb-args.ts';

export interface UnavailableVerb {
  readonly verb: string;
  readonly usage: string;
  /** The one line it answers, with exit 1 and nothing sent. */
  readonly answer: string;
}

const targeted = (
  id: string | undefined,
  flags: Readonly<Record<string, string | true>>,
): Body => ({
  recordId: target(id),
  expectedRevision: revision(flags),
});

/** `a=<id> b=<id>`: a chart's refs, each with the ticket it became. */
const refs = (detail: Readonly<Record<string, unknown>>): string => {
  const tickets = detail['tickets'];
  if (typeof tickets !== 'object' || tickets === null || Array.isArray(tickets)) return '';
  return Object.entries(tickets as Record<string, unknown>)
    .map(([ref, id]) => `${ref}=${String(id)}`)
    .join(' ');
};

/** `1=<id> 2=<id>`: a graduation's tickets, in the order they were listed. */
const inOrder = (detail: Readonly<Record<string, unknown>>): string => {
  const tickets = detail['tickets'];
  if (!Array.isArray(tickets)) return '';
  return tickets.map((id, at) => `${String(at + 1)}=${String(id)}`).join(' ');
};

export const TRACKER_VERBS: readonly VerbRow[] = [
  {
    verb: 'map chart',
    command: 'map.chart',
    usage:
      '--title <t> [--destination <d>] [--notes <n>] [--fog <json list>] [--tickets <json list of {ref,title,type,blockedBy?}>] [--out-of-scope <json list>]',
    body: (_id, flags) => ({
      title: need(flags, 'title'),
      ...optional('destination', maybe(flags, 'destination')),
      ...optional('notes', maybe(flags, 'notes')),
      ...jsonList(flags, 'fog'),
      ...jsonList(flags, 'tickets'),
      ...jsonList(flags, 'out-of-scope'),
    }),
    more: refs,
  },
  {
    verb: 'map revise',
    command: 'map.revise',
    usage:
      '<map> --revision n [--destination <d>] [--notes <n>] [--add-fog <json list>] [--add-out-of-scope <json list>] [--retire <id,id>]',
    body: (id, flags) => ({
      ...targeted(id, flags),
      ...optional('destination', maybe(flags, 'destination')),
      ...optional('notes', maybe(flags, 'notes')),
      ...jsonList(flags, 'add-fog'),
      ...jsonList(flags, 'add-out-of-scope'),
      ...(maybe(flags, 'retire') === undefined ? {} : { retire: idList(flags, 'retire') }),
    }),
  },
  {
    verb: 'map graduate',
    command: 'map.graduate',
    usage: '<map> --revision n --patch <fog id> --tickets <json list of {title,type}>',
    body: (id, flags) => ({
      ...targeted(id, flags),
      patchId: need(flags, 'patch'),
      tickets: jsonList(flags, 'tickets')['tickets'] ?? need(flags, 'tickets'),
    }),
    more: inOrder,
  },
  {
    verb: 'task claim',
    command: 'task.claim',
    usage: '<id> --revision n (first come)',
    body: targeted,
  },
  {
    verb: 'task type',
    command: 'task.set_type',
    usage: '<id> --revision n --type research|prototype|grilling|task|build',
    body: (id, flags) => ({ ...targeted(id, flags), taskType: need(flags, 'type') }),
  },
  {
    verb: 'task out-of-scope',
    command: 'task.close_out_of_scope',
    usage: '<id> --revision n --reason <one line>',
    body: (id, flags) => ({ ...targeted(id, flags), reason: need(flags, 'reason') }),
  },
  {
    verb: 'task close',
    command: 'task.complete',
    usage: '<id> --revision n',
    body: targeted,
  },
];

/** Operations the tracker names that have no home yet: each says so, and nothing is sent or kept. */
export const UNAVAILABLE_VERBS: readonly UnavailableVerb[] = [
  {
    verb: 'task research',
    usage: '<id> (a research artefact: a Docs page, not available until Docs)',
    answer:
      'refused NOT_AVAILABLE. A research artefact is a Docs page linked to the ticket, not available until Docs.',
  },
];
