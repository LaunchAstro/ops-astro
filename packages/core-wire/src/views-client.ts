// SPDX-License-Identifier: AGPL-3.0-only
//
// The client record's read results (C32) and its privacy settings (C60), as
// they cross the wire. Types only, re-exported by `views.ts`, which holds
// every other read result and is at its line cap.

/** One client record (C32): an organisation the business works for. */
export interface ClientView {
  readonly clientId: string;
  readonly name: string;
}

/** The owning task read's client metadata, under the current client grants. */
export type TaskClientSummary =
  | { readonly kind: 'none' }
  | { readonly kind: 'readable'; readonly name: ClientView['name'] }
  | { readonly kind: 'withheld' };

/** The internal owning task read's client projection and content-lock facts. */
export interface TaskClientFacts {
  /**
   * The client the task is under, by id (C32), or null for none (MP-4-8). Its
   * name is carried in `clientSummary`. A client the reader's grants do not reach is sent
   * as null too, beside `clientSet: true` (CS-4.12): no id `client.list` withholds.
   */
  readonly client: string | null;
  /** Absent on an older answer; never permission to infer a client name. */
  readonly clientSummary?: TaskClientSummary;
  /** True once the task has content, so its client is locked (S0-5, `CLIENT_LOCKED`). */
  readonly hasContent: boolean;
}

/** `client.list`'s answer: the clients the caller's live grants reach. */
export interface ClientListResult {
  readonly ok: true;
  readonly clients: readonly ClientView[];
}

/**
 * A client's privacy settings on its record (C60, CS-7.40), each off for a new
 * client: model use and the providers it may reach, health information, and
 * no agent edits. Never the written requests behind them.
 */
export interface ClientPrivacyView {
  readonly clientId: string;
  readonly modelEgress: boolean;
  readonly providers: readonly string[];
  readonly handlesHealth: boolean;
  readonly noAgentEdits: boolean;
}
