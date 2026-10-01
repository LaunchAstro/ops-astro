// SPDX-License-Identifier: AGPL-3.0-only
//
// The seam between LA-1's tick (tick.ts) and its approval gate (approval.ts,
// filled in by tick-main.ts). Its own file, so the tick never imports
// approval.ts, which imports the tick.

/** The approval gate's own work: the tick never sends it to the model. */
export const APPROVAL_PURPOSE = 'local_agent_approval';

/** A lease the tick holds work under, as its pickup returned it. */
export interface HeldLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

/**
 * The local approval gate's two moments in a task pass, handed to the tick;
 * the tick process fills it from approval.ts (tick-main.ts).
 */
export interface TickGate {
  /**
   * Before the queue is read: approved approvals applied, so the pass runs under
   * them. A code when they could not be (APPROVALS_LOCKED); the pass still runs.
   */
  readonly beforeTasks: () => Promise<string | undefined>;
  /**
   * A model step that came back released, its work still under the lease.
   * The code the gate handed the work back under, or undefined when the
   * release is not the gate's and the tick goes on as without one.
   */
  readonly onReleased: (lease: HeldLease) => Promise<string | undefined>;
}
