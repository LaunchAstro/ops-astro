// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: the runner's settings from a file, not read yet.

type Environment = Readonly<Record<string, string | undefined>>;

export type FileSettings =
  | { readonly ok: true; readonly env: Environment }
  | { readonly ok: false; readonly message: string };

export function withSettingsFile(env: Environment): FileSettings {
  return { ok: true, env };
}
