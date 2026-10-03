// SPDX-License-Identifier: AGPL-3.0-only
//
// The client views (C32), beside `views.ts`, which re-exports them.

/** One client record (C32): an organisation the business works for. */
export interface ClientView {
  readonly clientId: string;
  readonly name: string;
}

/** `client.list`'s answer: the clients the caller's live grants reach. */
export interface ClientListResult {
  readonly ok: true;
  readonly clients: readonly ClientView[];
}
