// SPDX-License-Identifier: AGPL-3.0-only
//
// The shapes the hidden-task live board cases share: a board row, an open tab
// and the hidden task stirred under it.

import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';

export interface Row {
  readonly id: string;
  readonly actualMinutes: number;
  readonly waitReason: string | null;
  readonly state: { readonly id: string; readonly label: string } | null;
  readonly assignee: { readonly personId: string; readonly name: string } | null;
}

export interface Tab {
  resyncs(): number;
  stop(): Promise<void>;
}

/** A task in `businessKey`, worked by `owner`, assigned to `assignee`, started, and waiting at a gate. */
export interface Hidden {
  readonly businessKey: string;
  readonly business: BusinessId;
  readonly owner: Member;
  readonly assignee: Member;
  readonly taskId: string;
  readonly gateId: string;
}

export const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};
