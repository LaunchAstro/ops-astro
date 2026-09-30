// SPDX-License-Identifier: AGPL-3.0-only
//
// The task stage list (owner, Stage 1 adds, 30 Sep 2026; the mockup's
// TASK_STAGES, WIRING §43): the six journey stages, Awareness to Advocacy, in
// journey order, then Ops. Ops is deliberately not a journey stage: the
// journey is the client's customer journey, and running the account is not a
// stage their customer passes through. `list()` is the one place Ops is
// appended, so no surface decides on its own to show or hide it; `internal`
// is what a client face checks.
//
// A task stores the stage's id (`task.set_stage`); the task page, the dock
// panel's Stage select (DP-24) and the board's Stage column read the label
// here. A stored value outside the list is shown as it is stored, never
// renamed and never dropped.

export interface TaskStage {
  readonly id: string;
  readonly n: number;
  readonly label: string;
  /** What the stage is about, in the client's words. */
  readonly say: string;
  /** True for Ops alone: never drawn on a client face. */
  readonly internal: boolean;
}

const JOURNEY: readonly TaskStage[] = [
  {
    id: 'awareness',
    n: 1,
    label: 'Awareness',
    say: 'Strangers discover you exist',
    internal: false,
  },
  {
    id: 'trust',
    n: 2,
    label: 'Trust',
    say: 'Prospects weigh their options and build trust',
    internal: false,
  },
  {
    id: 'enquiries',
    n: 3,
    label: 'Enquiries',
    say: 'Turning interest into action',
    internal: false,
  },
  {
    id: 'sales',
    n: 4,
    label: 'Sales',
    say: 'Following up — leads become customers',
    internal: false,
  },
  {
    id: 'retention',
    n: 5,
    label: 'Retention',
    say: 'Customers stay, succeed and spend more',
    internal: false,
  },
  {
    id: 'advocacy',
    n: 6,
    label: 'Advocacy',
    say: 'Happy customers drive referrals',
    internal: false,
  },
];

const OPS: TaskStage = {
  id: 'ops',
  n: 0,
  label: 'Ops',
  say: 'Running the account — reporting, renewals, invoicing, chasing',
  internal: true,
};

const ALL: readonly TaskStage[] = [...JOURNEY, OPS];

export const TASK_STAGES = {
  /** The menu in reading order: the six in journey order, Ops last. */
  list: (): readonly TaskStage[] => ALL,
  /** The stage a stored value claims, defended: unknown or missing reads as Ops. */
  of: (stored: string | null): string =>
    ALL.some((stage) => stage.id === stored) ? (stored as string) : OPS.id,
  /** A stored stage's label; a value outside the list as it is stored. */
  labelOf: (stored: string): string => ALL.find((stage) => stage.id === stored)?.label ?? stored,
  /** The id a label names; a label outside the list is its own value. */
  idOf: (label: string): string => ALL.find((stage) => stage.label === label)?.id ?? label,
};
