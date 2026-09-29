// SPDX-License-Identifier: AGPL-3.0-only
//
// The fixture's shape, SPEC 10.1 (ops-astro-roadmap, research/task-demo-spec),
// as data. Test tooling, never shipped. The generator takes any shape, so a
// suite can seed this one at a small scale and the snapshot build the full.
//
// Which path writes each dimension (the coordinator's ruling on Sol's review
// 2): tasks, subtasks, comments, trash, lineages, the runs and each run's
// first step and its claimed and handed-back events go through the commands.
// People, grants, clients, the agent and the preset fields go through the
// records layer, since no command issues them. So do the steps past the first
// and the events past the pair, on the admin connection: through the commands
// a version plans exactly one step (`proposal-writer.ts`, ordinal 1) and T2a
// writes two events per pickup and hand-back, so no command reaches SPEC
// 10.1's 1,200 steps, 6,000 events and one run held at 1,500.

import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';

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
  /** Planned steps across all runs, the first of each from the command. */
  readonly steps: number;
  /** Run events across the runs, and the share one run holds (1,500 of 6,000). */
  readonly runEvents: number;
  readonly heldRunShare: number;
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
  steps: 1_200,
  runEvents: 6_000,
  heldRunShare: 0.25,
};

/** What a seed reports: the ids and callers the suites read with. */
export interface FixtureReport {
  readonly board: string;
  readonly recordGrantTask: string;
  readonly slots: { readonly assigned: number; readonly total: number };
  readonly people: { readonly alpha: readonly string[]; readonly bravo: readonly string[] };
  readonly seedMs: number;
  /** Who the isolation cases read as: a client sees its own shared task only. */
  readonly callers: {
    readonly alpha: BusinessId;
    readonly bravo: BusinessId;
    readonly bravoLead: VerifiedSubject;
    readonly r4: VerifiedSubject;
    readonly clients: readonly {
      readonly business: BusinessId;
      readonly presented: VerifiedSubject;
      readonly task: string;
    }[];
  };
  /** SPEC 10.1 rows this base cannot hold yet (run events wait on T2a's table). */
  readonly heldBack: readonly string[];
}
