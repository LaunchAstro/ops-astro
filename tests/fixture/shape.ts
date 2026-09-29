// SPDX-License-Identifier: AGPL-3.0-only
//
// The fixture's shape, SPEC 10.1 (ops-astro-roadmap, research/task-demo-spec),
// as data. Test tooling, never shipped. The generator takes any shape, so a
// suite can seed this one at a small scale and the snapshot build the full.
//
// The run rows are held back, and the report says so. Through the commands a
// proposal version plans exactly one step (`proposal-writer.ts`, ordinal 1),
// and T2a writes two events per pickup and hand-back; a failed hand-back
// settles the hold and a restart opens a new lineage. So events never exceed
// twice the steps, and the SPEC's 1,200 steps, 6,000 events and one run at
// 1,500 cannot be reached without writing rows no command wrote.

export interface FixtureShape {
  /** Task records in A and B, subtasks and trashed ones included. */
  readonly tasksA: number;
  readonly tasksB: number;
  /** A's people, one per isolation role R1 to R6. */
  readonly peopleA: number;
  readonly clientsPerBusiness: number;
  readonly sections: number;
  /** Slots the task type assigns, spine and preset fields together; the rest stay null. */
  readonly taskSlots: number;
  /** Records with a parent, and of those, records whose parent has one. */
  readonly withParent: number;
  readonly withGrandparent: number;
  readonly comments: number;
  /** The one thread-paging case; every other thread holds at most the ceiling. */
  readonly hotThread: number;
  readonly threadCeiling: number;
  /** One subtree trashed in one batch, after `earlier` of its records were. */
  readonly trash: { readonly batch: number; readonly earlier: number };
  readonly lineages: {
    readonly total: number;
    readonly twoVersions: number;
    readonly threeVersions: number;
  };
  /** Proposed, approved, picked up and handed back, each on a task of its own. */
  readonly runs: number;
}

export const FIXTURE_SHAPE: FixtureShape = {
  tasksA: 5_000,
  tasksB: 500,
  peopleA: 6,
  clientsPerBusiness: 2,
  sections: 3,
  taskSlots: 24,
  withParent: 600,
  withGrandparent: 60,
  comments: 20_000,
  hotThread: 500,
  threadCeiling: 5,
  trash: { batch: 40, earlier: 5 },
  lineages: { total: 200, twoVersions: 30, threeVersions: 5 },
  runs: 300,
};
