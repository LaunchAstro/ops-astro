// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy on Vercel (ticket S0-6): not built yet.

export interface WebDeployRecord {
  readonly action: 'deploy recorded';
  readonly [key: string]: unknown;
}

export type WebDeployOutcome =
  { kind: 'refused' | 'failed'; reason: string } | { kind: 'deployed'; record: WebDeployRecord };

export async function deployWeb(
  _request: { version: string; store: string },
  _options: {
    env: Readonly<Record<string, string | undefined>>;
    preflight: () => Promise<string[]>;
  },
): Promise<WebDeployOutcome> {
  return await Promise.resolve({ kind: 'deployed', record: { action: 'deploy recorded' } });
}
