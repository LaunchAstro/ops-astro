// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's settings (LA-1, #859): not built yet; refuses every start.

export interface RunnerSettings {
  readonly seat: string;
  readonly seatDir: string;
  readonly capUsd: number;
}

export type SettingsResult =
  | { readonly ok: true; readonly settings: RunnerSettings }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function readSettings(
  _env: Readonly<Record<string, string | undefined>>,
  _userHome?: string,
): SettingsResult {
  return { ok: false, code: 'NOT_BUILT', message: 'not built' };
}
