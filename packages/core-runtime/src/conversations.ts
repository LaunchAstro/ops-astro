// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's two system operations (AW-03): the wrap-up written at
// quiet, and the purge of the body after the business's window. The shapes
// are declared here first so the named tests can be written against them;
// the operations land with the records they read.

import type { TenantQuery } from '../../core-records/src/index.ts';

export interface WrapUpRequest {
  readonly conversationId: string;
  /** The code revision the writer runs, recorded on the wrap-up. */
  readonly codeRevision: string;
}

export type WrapUpOutcome =
  | { readonly ok: true; readonly version: number; readonly written: boolean }
  | { readonly ok: false; readonly reason: 'not_quiet' | 'purged' | 'not_found' };

export interface PurgeRequest {
  readonly conversationId: string;
  /** The purge's identity: a second call with it is the same purge. */
  readonly operationId: string;
}

export type PurgeRefusalCode = 'WRAP_UP_ABSENT' | 'WORK_OPEN' | 'NOT_DUE' | 'WINDOW_UNREADABLE';

export type PurgeOutcome =
  | { readonly ok: true; readonly replayed: boolean; readonly messagesPurged: number }
  | { readonly ok: false; readonly code: PurgeRefusalCode | 'NOT_FOUND' };

export function writeWrapUp(_tx: TenantQuery, _request: WrapUpRequest): Promise<WrapUpOutcome> {
  return Promise.reject(new Error('writeWrapUp: not built yet'));
}

export function purgeConversation(_tx: TenantQuery, _request: PurgeRequest): Promise<PurgeOutcome> {
  return Promise.reject(new Error('purgeConversation: not built yet'));
}
