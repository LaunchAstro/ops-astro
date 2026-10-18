// SPDX-License-Identifier: AGPL-3.0-only

import { tokenHolder, type TokenHolder, type TokenHolderOptions } from './plan-token.ts';

export function productionTokenHolder(
  options: Omit<TokenHolderOptions, 'fs'>,
):
  | { readonly ok: true; readonly holder: TokenHolder }
  | { readonly ok: false; readonly code: 'SUBSCRIPTION_ISSUER_REFUSED' } {
  return { ok: true, holder: tokenHolder(options) };
}
