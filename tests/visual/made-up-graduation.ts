// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for the per-client region of Connections & signal: its
// graduation rows and standing mandates (MP-14-10a), kept as main's read
// orders and derives them. Test side only, like made-up-connections.ts, which
// serves them. Every client, class and sentence is made up.

import type {
  ConnectionGraduationResult,
  GraduationRowView,
} from '../../packages/core-wire/src/index.ts';

// Scopes as main's scopeChoices orders them: every class, then families, then classes.
const MERIDIAN = { id: 'c-meridian', label: 'Meridian Dental', scopes: ['*', 'ads.*', 'review.*'] };
const HARBOUR = {
  id: 'c-harbour',
  label: 'Westshore Legal',
  scopes: ['*', 'ads.*', 'connector.*'],
};
const grad = (
  n: number,
  row: Pick<GraduationRowView, 'actionClass' | 'classLabel' | 'clearance' | 'state' | 'note'> &
    Partial<GraduationRowView>,
): GraduationRowView => ({
  id: `g-${String(n)}`,
  clientId: MERIDIAN.id,
  heldBy: null,
  neverWhy: null,
  promotedAt: null,
  approved: 0,
  edited: 0,
  rejected: 0,
  since: null,
  revision: 1,
  ...row,
});

export const GRADUATION: ConnectionGraduationResult = {
  ok: true,
  // In name order, as main reads them; the page opens on the first.
  clients: [MERIDIAN, HARBOUR],
  rows: [
    grad(1, {
      actionClass: 'review.chase.send',
      classLabel: 'Review chase',
      clearance: 'Draft',
      state: 'ready',
      approved: 47,
      since: '12 Jun',
      note: '47 approved, none edited, none rejected. A chase goes to the patient, not the practice.',
    }),
    grad(2, {
      actionClass: 'connector.resync',
      classLabel: 'Connector force resync',
      clearance: 'Observe',
      state: 'promoted',
      promotedAt: '2026-06-19T00:00:00.000Z',
      approved: 112,
      since: '03 Apr',
      note: 'A resync re-reads data we already hold permission to read.',
    }),
    grad(3, {
      actionClass: 'gbp.post.publish',
      classLabel: 'Google Business publish post',
      clearance: 'Configure',
      state: 'short',
      approved: 18,
      edited: 2,
      since: '21 May',
      note: 'Eighteen went clean and two were rewritten before they went.',
    }),
    grad(4, {
      actionClass: 'recommendation.send',
      classLabel: 'Client send recommendation',
      clearance: 'Draft',
      state: 'never',
      neverWhy: 'audience',
      approved: 23,
      edited: 4,
      since: '04 Mar',
      note: 'The client reads this one, so it never sends itself.',
    }),
    grad(5, {
      clientId: HARBOUR.id,
      actionClass: 'connector.resync',
      classLabel: 'Connector force resync',
      clearance: 'Observe',
      state: 'held',
      heldBy: 'a1b2c3d4-0000-4000-8000-000000000002',
      approved: 84,
      since: '11 Feb',
      note: 'Clears the bar and is held by the refusal below.',
    }),
  ],
  mandates: [
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      clientId: MERIDIAN.id,
      classes: ['ads.negative_keywords.add'],
      refuses: false,
      ceiling: { amountMinor: 50000, currency: 'AUD' },
      expiresAt: '2026-12-31T13:59:59.000Z',
      expired: false,
      label: 'Negative keywords may be added to the brand campaign without asking.',
      graduationClass: null,
      authoredBy: 'p-nathan-0000',
      createdAt: '2026-07-22T00:00:00.000Z',
      revision: 1,
    },
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000002',
      clientId: HARBOUR.id,
      classes: ['*'],
      refuses: true,
      ceiling: null,
      expiresAt: '2026-10-31T13:59:59.000Z',
      expired: false,
      label: 'Nothing at Westshore runs unattended while the review is open.',
      graduationClass: null,
      authoredBy: 'p-mia-000000',
      createdAt: '2026-07-29T00:00:00.000Z',
      revision: 1,
    },
    // The live promotion behind g-2: main shows a class promoted only while one stands.
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000003',
      clientId: MERIDIAN.id,
      classes: ['connector.resync'],
      refuses: false,
      ceiling: null,
      expiresAt: '2027-06-18T13:59:59.000Z',
      expired: false,
      label: 'A connector resync may run without asking.',
      graduationClass: 'connector.resync',
      authoredBy: 'p-nathan-0000',
      createdAt: '2026-06-19T00:00:00.000Z',
      revision: 1,
    },
  ],
};
