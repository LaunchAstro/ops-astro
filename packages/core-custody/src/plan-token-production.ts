// SPDX-License-Identifier: AGPL-3.0-only
//
// The production composition's plan token holder (#1704). Its token URL must
// be on `https://auth.openai.com` exactly, with no credentials in it. Anything
// else, a loopback test issuer included, is refused here at start with a
// typed refusal, before any lock, file or request. Tests build `tokenHolder`
// on their 127.0.0.1 issuer instead. Custody's process builds it (`custody-plan.ts`).

import { tokenHolder, type TokenHolder, type TokenHolderOptions } from './plan-token.ts';
import { planIssuer } from './token-refresh.ts';

export type IssuerRefusal = 'SUBSCRIPTION_ISSUER_REFUSED';

export function productionTokenHolder(
  options: Omit<TokenHolderOptions, 'fs'>,
):
  | { readonly ok: true; readonly holder: TokenHolder }
  | { readonly ok: false; readonly code: IssuerRefusal } {
  // Judged on a private copy, so the caller's later edit to its URL cannot redirect the holder.
  const tokenUrl = new URL(options.tokenUrl.href);
  if (!planIssuer(tokenUrl)) return { ok: false, code: 'SUBSCRIPTION_ISSUER_REFUSED' };
  const { file, now, log } = options;
  // Rebuilt field by field: no fault-injecting `fs` reaches production.
  return {
    ok: true,
    holder: tokenHolder({
      file,
      tokenUrl,
      ...(now === undefined ? {} : { now }),
      ...(log === undefined ? {} : { log }),
    }),
  };
}
