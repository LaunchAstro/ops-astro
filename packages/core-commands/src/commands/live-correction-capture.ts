// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's capture port is the C18-1 fence itself: the runner is given the
// fence's inputs (the catalogue pool, a resolver, the pinned transport) and
// captures through `capturePage`, so no caller can hand in a capture that
// skips the fence. The page is the correction's stored `pageUrl`, which is as
// the requester sent it, so it is checked against the catalogue before the
// run reads or sends anything: a publish nobody can observe is an effect
// nobody can verify.

import {
  capturePage,
  checkPageAllowed,
  type CaptureOptions,
  type FenceCode,
} from '../../../core-connectors/src/index.ts';

export type CaptureAnswer =
  { readonly ok: true; readonly value: { readonly text: string } } | { readonly ok: false };

/** The correction's own page, captured through the fence. */
export async function captureFenced(url: string, fence: CaptureOptions): Promise<CaptureAnswer> {
  const page = await capturePage(url, fence);
  return page.ok ? { ok: true, value: { text: page.value.text } } : { ok: false };
}

/** The fence's refusal of the stored page, recorded with the origin only, or nothing. */
export function pageNotCatalogued(url: string, fence: CaptureOptions): FenceCode | undefined {
  const allowed = checkPageAllowed(url, fence.pool);
  if (allowed.ok) return undefined;
  const origin = URL.canParse(url) ? new URL(url).origin : '';
  fence.record?.({ code: allowed.code, hop: 0, origin });
  return allowed.code;
}
