// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 skeleton for the red run: signatures only, built in the next commit.

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

export const REPLAY_MODEL_WINDOW: { readonly model: string; readonly contextUnits: number } = {
  model: 'replay-1',
  contextUnits: 32_000,
};
export const REPLAY_NOTHING_HAPPENED = 'rejected_before_processing';
export const REPLAY_PATH = '/v1/complete';

export function replayAdapter(_values: Readonly<Record<string, string>>): AdapterRequest {
  throw new Error('AW-01: not built');
}

export function readReplayAnswer(_body: unknown): ModelAnswer | undefined {
  throw new Error('AW-01: not built');
}

/** One catalogued operation over the replay provider, used by the broker's cases and the stand-in stack. */
export const REPLAY_COMPOSE: ModelOperationDeclaration = {
  key: 'model.replay_compose',
  provider: 'replay',
  destination: 'replay',
  fields: { instruction: 'free_text', tone: 'business_internal' },
  answer: readReplayAnswer,
  timeoutMs: 2_000,
  maxResponseBytes: 64 * 1024,
  maximumMinor: 500,
  settlesAt: 'completed',
  nothingHappened: [REPLAY_NOTHING_HAPPENED],
  billed: true,
  concurrency: 4,
};

export function replayCostMinor(_answer: ModelAnswer): number {
  throw new Error('AW-01: not built');
}

export type ReplayMode =
  | 'answer'
  | 'oversized'
  | 'redirect'
  | 'malformed'
  | 'slow'
  | 'planted'
  | 'echo_credential'
  | 'nothing_happened'
  | 'costly';

export interface SeenRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface ReplayProvider {
  readonly origin: string;
  readonly seen: readonly SeenRequest[];
  mode(next: ReplayMode): void;
  close(): Promise<void>;
}

export async function startReplayProvider(): Promise<ReplayProvider> {
  await Promise.resolve();
  throw new Error('AW-01: not built');
}
