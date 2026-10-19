// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's part of the matrix's body context (`role-case-bodies.ts`), apart so the
// shared context and C80's recipes (`c80-bodies.ts`) both depend on it.

/** What C80's recipes ask of a harness beyond the shared body context. */
export interface C80Seeds {
  /** A live correction another member requested, for C80's approval (never the admin's own). */
  seedCorrection?(): Promise<{ readonly correctionId: string; readonly versionId: string }>;
  /** Such a correction recorded live owner-side, the admin its decider, for C80's revert ask. */
  seedLiveCorrection?(): Promise<{ readonly correctionId: string; readonly versionId: string }>;
  /** Bind a client's own about page, for C80's request; the page's address. */
  bindClientSite?(partyId: string): Promise<string>;
  /**
   * C35-X: the next revision of the admin's review of this page, written by a new member
   * through the records' open, so the admin decides a revision that is not their own.
   */
  reviseAsAnother?(page: Readonly<Record<string, unknown>>): Promise<{ readonly digest: string }>;
}
