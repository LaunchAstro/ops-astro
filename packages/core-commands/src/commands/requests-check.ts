// SPDX-License-Identifier: AGPL-3.0-only
//
// The run's check's request shape (MP-6-1), a part of `CommandRequest` kept
// beside it so `requests.ts` stays under the per-file cap. It is recorded
// under the worker lease the caller names, with its fence.

import type { Envelope } from './request-envelope.ts';

export type CheckRequest = {
  readonly command: 'task.check';
  readonly leaseId: string;
  readonly fence: number;
  readonly name: string;
  readonly outcome: string;
  readonly note?: string | null;
} & Envelope;
