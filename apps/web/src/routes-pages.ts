// SPDX-License-Identifier: AGPL-3.0-only
//
// Two agency pages kept apart from `routes.ts` so it stays under its line cap;
// `ROUTES` spreads them in place and checks them as it checks its own.

export const PAGE_ROUTES = {
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
} as const;
