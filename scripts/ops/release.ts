// SPDX-License-Identifier: AGPL-3.0-only
//
// The release step (tickets S0-1 and S0-6, the Vercel re-plan). Not written
// yet: it writes nothing.

/** What a release records: the web build's stamp and the output's digest. */
export interface Release {
  readonly build: string;
  readonly digest: string;
}

export function outputDigest(_out: string): string {
  return '';
}

export async function release(_paths: { dist: string; out: string }): Promise<Release> {
  return await Promise.reject(new Error('the release step is not written yet'));
}
