// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's open request to delete it (#2351), as `task.read` sends it, apart
// from `views.ts` to keep that file under the product line limit.

/** An open request to delete a task: who asked, why, and when it lapses unanswered. */
export interface DeleteRequestView {
  readonly id: string;
  readonly reason: string;
  /** Whether an agent asked, rather than a person. */
  readonly byAgent: boolean;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}
