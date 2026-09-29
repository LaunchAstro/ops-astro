// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's conversation at three detail levels (MP-4-5, CS-15.19). Red stub.

import type { TenantQuery } from '../../../core-records/src/index.ts';

export type ConversationLevel = 'brief' | 'standard' | 'full';

export interface ConversationRead {
  readonly level: ConversationLevel;
  readonly counts: Readonly<Partial<Record<'internal' | 'client', number>>>;
  readonly last?: Readonly<Record<string, unknown>> | null;
  readonly messages?: readonly Readonly<Record<string, unknown>>[];
}

export async function readConversation(
  _tx: TenantQuery,
  _commentTypeId: string | undefined,
  _taskId: string,
  level: ConversationLevel,
  _internal: boolean,
): Promise<ConversationRead> {
  return await Promise.resolve({ level, counts: {} });
}
