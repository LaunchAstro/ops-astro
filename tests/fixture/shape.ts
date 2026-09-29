// SPDX-License-Identifier: AGPL-3.0-only
//
// The fixture's shape, SPEC 10.1 (ops-astro-roadmap, research/task-demo-spec),
// as data. Test tooling, never shipped. The generator takes any shape, so a
// suite can seed this one at a small scale and the snapshot build the full.
//
// Two dimensions of the table are held back, and the report says so: the
// SPEC's 1,200 steps and 6,000 run events with one run at 1,500 need a run
// with many attempts, which no command reaches at this base. Each run here is
// one pickup and one hand-back, so its events are what T2a writes for that.

export interface FixtureShape {
  /** Task records in A and B, subtasks and trashed ones included. */
  readonly tasksA: number;
  readonly tasksB: number;
  /** A's people, one per isolation role R1 to R6. */
  readonly peopleA: number;
  readonly clientsPerBusiness: number;
  readonly sections: number;
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
  withParent: 600,
  withGrandparent: 60,
  comments: 20_000,
  hotThread: 500,
  threadCeiling: 5,
  trash: { batch: 40, earlier: 5 },
  lineages: { total: 200, twoVersions: 30, threeVersions: 5 },
  runs: 300,
};
