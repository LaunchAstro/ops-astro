// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's door (LA-1, #859): not built yet.

import type { RunnerSettings } from './settings.ts';

export interface Runner {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createRunner(
  _settings: RunnerSettings,
  _log?: (line: string) => void,
): Promise<Runner> {
  throw new Error('not built');
}
