// SPDX-License-Identifier: AGPL-3.0-only
//
// Agency and portal pages kept apart from `routes.ts` so it stays under its line cap;
// `ROUTES` spreads them in place and checks them as it checks its own.

export const PAGE_ROUTES = {
  // The business's reviews the reader's grant covers (MP-8-1), each linked to its workspace.
  'agency:reviews': {
    namespace: 'agency',
    path: '/projects/reviews/',
    title: 'Reviews',
    surface: 'none',
    authenticated: true,
  },
  // The Executive page: section 005, what our agents cost us, reads for real
  // and 001 to 004 stand in. The manifest's Dashboard section already lists
  // this address, so it adds no rail door.
  'agency:executive': {
    namespace: 'agency',
    path: '/dashboard/executive/',
    title: 'Executive',
    surface: 'none',
    authenticated: true,
  },
  // A new client's onboarding in phases, drawn from made-up data under the
  // mock label until an onboarding read exists; no manifest page, so no rail
  // entry.
  'agency:onboarding': {
    namespace: 'agency',
    path: '/onboarding/',
    title: 'Onboarding',
    surface: 'none',
    authenticated: true,
  },
  // A team invitation's one-time link (C39-T): the token is in the fragment,
  // so the address the registry matches is the page alone, with no sign-in.
  'agency:enrol': {
    namespace: 'agency',
    path: '/enrol/',
    title: 'Join your team',
    surface: 'none',
    authenticated: false,
  },
  // The Review workspace (C35, #2105): one review, under the projects' Reviews page. The
  // manifest's row keeps it out of the rail; the Projects section is lit for it.
  'agency:review-workspace': {
    namespace: 'agency',
    path: '/projects/reviews/:review',
    title: 'Review workspace',
    surface: 'none',
    authenticated: true,
  },
  // The client's own reviews (PROTO-GAPS row 7), drawn from `review.client_list`: what the
  // client may see of each, never the team's review. The read is the gate; the address's
  // client only names the face.
  'portal:reviews': {
    namespace: 'portal',
    path: '/portal/:client/projects/reviews/',
    title: 'Reviews',
    surface: 'none',
    authenticated: true,
  },
} as const;
