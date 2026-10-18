// SPDX-License-Identifier: AGPL-3.0-only
// Stub for the red run.
export function loadSiteEntry(_file: string, _entry: string, _value: string): string {
  return 'refused NOT_BUILT';
}
export async function smokeSite(
  _file: string,
  _options: unknown,
): Promise<{ ok: boolean; lines: string[] }> {
  return { ok: false, lines: [] as string[] };
}
process.exitCode = 1;
