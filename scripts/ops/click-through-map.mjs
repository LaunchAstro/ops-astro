// SPDX-License-Identifier: AGPL-3.0-only
//
// The click-through seed's Wayfinder map (SR-1), drawn by the map page's four
// views: the map, its tickets, its frontier and its fog. `w` is
// `click-through-work.mjs`'s world. Ada charts it through `map.chart`,
// resolves its research ticket into Decisions so far and claims its build
// ticket, so the frontier is the open, unblocked, unclaimed rest. It names no
// client: the business's own made-up work.

/** The map's title, by which the seed finds it again. */
export const MAP_TITLE = 'Plan the new agency website';

const RESEARCH = 'Choose the enquiry form';
const BUILD = 'Build the enquiry page';
const GIST = 'Keep the form the agency already uses.';

const CHART = {
  title: MAP_TITLE,
  destination: 'A new agency website that takes an enquiry in two taps.',
  notes: 'A made-up map for the click-through: the owner signs off the copy.',
  tickets: [
    { ref: 'form', title: RESEARCH, type: 'research' },
    { ref: 'copy', title: 'Draft the home page copy', type: 'task', blockedBy: ['form'] },
    { ref: 'build', title: BUILD, type: 'build', blockedBy: ['form'] },
    {
      ref: 'launch',
      title: 'Settle the launch date',
      type: 'grilling',
      blockedBy: ['copy', 'build'],
    },
    { ref: 'menu', title: 'Try a shorter menu', type: 'prototype' },
  ],
  fog: ['Whether the old blog posts move across', 'Which photos the site may use'],
  outOfScope: ['A booking system'],
};

/**
 * Its end state, asked of the map ($1) in the business ($2), with the
 * operands after: a resolved ticket carrying its gist, and a claimed one,
 * both filed under it.
 */
export const MAP_ENDED = [
  `select from public.records r
    where r.business_id = $2 and r.id = $1 and r.data ->> 'type' = 'map'
      and exists (select from public.records t where t.business_id = $2 and t.uuid_4 = r.id
        and t.txt_4 = $3 and t.data ->> 'gist' = $4)
      and exists (select from public.records t where t.business_id = $2 and t.uuid_4 = r.id
        and t.txt_4 = $5 and t.data ->> 'assignee' is not null)`,
  RESEARCH,
  GIST,
  BUILD,
];

/** The map charted, one ticket resolved and one claimed, each as Ada. */
export async function chartMap(w) {
  const charted = await w.as(w.admin, { command: 'map.chart', ...CHART });
  const ticket = (ref) => charted.tickets[ref];
  await w.as(w.admin, {
    command: 'task.resolve',
    recordId: ticket('form'),
    expectedRevision: await w.revision(ticket('form')),
    answer: 'The agency already pays for an enquiry form; the new site embeds it.',
    gist: GIST,
  });
  await w.as(w.admin, {
    command: 'task.claim',
    recordId: ticket('build'),
    expectedRevision: await w.revision(ticket('build')),
  });
}
