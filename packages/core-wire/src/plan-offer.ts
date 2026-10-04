// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: a plan version as a planning reply offers it in the chat, carrying
// everything the drawer draws on the card and sends back on the one click
// (`task.accept_plan`). The accept never trusts it: the server compares the
// version under its locks and checks the record and paths by value
// (`commands/plan-accept.ts`), so this is what the person saw, not authority.
//
// The planning reply that composes one is AW-04's planning half; until a reply
// carries `plan`, the drawer draws no card and offers no accept.

export interface PlanOfferStep {
  readonly key: string;
  readonly title: string;
  readonly after: readonly string[];
}

export interface PlanOffer {
  readonly gateId: string;
  readonly versionId: string;
  /** The version's number as the person reads it beside the button. */
  readonly version: number;
  /** The task the plan is for, already made by the proposal, and its link. */
  readonly task: { readonly id: string; readonly key: string; readonly title: string };
  /** The exact words the click approves: the steps, the ceiling and the later launch. */
  readonly text: string;
  readonly steps: readonly PlanOfferStep[];
  /** The rough cost: the ceiling the words name, in minor units. */
  readonly ceilingMinor: number;
  readonly currency: string;
  /** What planning has spent so far on this conversation's envelope (U10). */
  readonly planningSpendMinor: number;
  /** The bootstrap file the click activates, and the other files the run may read. */
  readonly entryPath: string;
  readonly paths: readonly string[];
}
