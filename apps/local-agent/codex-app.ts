// SPDX-License-Identifier: AGPL-3.0-only
//
// One streamed call through `codex app-server` (#859). Stub: nothing is started yet.

import type { CodexResult, UNKNOWN } from './codex.ts';
import type { RunnerSettings } from './settings.ts';

export async function runCodexApp(
  _settings: RunnerSettings,
  _model: string,
  _prompt: string,
  _onDelta: (text: string) => void,
  _signal?: AbortSignal,
): Promise<CodexResult | typeof UNKNOWN | null> {
  return await Promise.resolve(null);
}
