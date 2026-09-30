// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's endings loop (red step: its surface only; the retry is still the API's).

export { retryAccessEndings } from '../api/server.ts';

/** The loop's settings, checked (red step: not yet checked). */
export function endingsSettings(
  _environment: Readonly<Record<string, string | undefined>>,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  return { ok: true };
}
