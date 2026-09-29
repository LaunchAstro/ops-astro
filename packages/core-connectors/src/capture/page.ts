// SPDX-License-Identifier: AGPL-3.0-only
//
// One fenced capture of a catalogued page, as the observation Receipt L
// compares. Not built yet.

import type { PageObservation } from '../site/envelope.ts';
import type { FetchOptions, Fenced } from './fence.ts';

export type CaptureOptions = Omit<FetchOptions, 'kind' | 'page'>;

export async function capturePage(
  url: string,
  options: CaptureOptions,
): Promise<Fenced<PageObservation>> {
  await Promise.resolve(options);
  return { ok: true, value: { url, status: 200, documentDigest: '', text: '', stylesheets: {} } };
}
