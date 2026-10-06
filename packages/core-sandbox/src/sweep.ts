// SPDX-License-Identifier: AGPL-3.0-only
//
// P6's sweep (docs/plan/sandbox-contract.md, section 6). Stub: it passes.

import type { SandboxResult } from './refusal.ts';

type Reply = { readonly status: number; readonly body: Uint8Array };
export type SweepDaemon = {
  readonly list: () => Promise<Reply>;
  readonly remove: (id: string) => Promise<Reply>;
  readonly info: () => Promise<Reply>;
};

export const SWEEP_RETRY_MS = 0;

export const sweep = (_daemon: SweepDaemon): Promise<SandboxResult<object>> =>
  Promise.resolve({ ok: true });
