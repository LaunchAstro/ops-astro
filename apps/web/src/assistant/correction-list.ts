// SPDX-License-Identifier: AGPL-3.0-only
//
// #1695: a desk's cards as `live_correction.list` answers them. A card the
// desk holds takes the listed state; a correction it does not hold yet is
// added, its page named by its address.

import type { CorrectionListItem } from '../../../../packages/core-wire/src/index.ts';
import { cardState } from './correction.ts';
import type { Correction } from './correction-desks.ts';

/** Where a listed correction stands, as the list answered it. */
const standing = (item: CorrectionListItem): Partial<Correction> => ({
  state: cardState(item.state),
  approver: item.approver,
  versionId: item.versionId,
  refusal: null,
});

/** A listed correction as its card holds it; the page is named by its address. */
const listed = (item: CorrectionListItem): Correction => ({
  correctionId: item.correctionId,
  ask: { page: item.pageUrl, word: item.word, replacement: item.replacement },
  state: cardState(item.state),
  approver: item.approver,
  versionId: item.versionId,
  verifiedForMs: 0,
  readAt: null,
  reason: null,
  refusal: null,
  receipts: null,
});

/** The cards with `items` as listed: a card held takes the listed state, a new one is added. */
export const withListed = (
  list: readonly Correction[],
  items: readonly CorrectionListItem[],
): readonly Correction[] => {
  const byId = new Map(items.map((item) => [item.correctionId, item]));
  const held = list.map((each) => {
    const item = byId.get(each.correctionId);
    return item === undefined ? each : { ...each, ...standing(item) };
  });
  const known = new Set(list.map((each) => each.correctionId));
  const fresh = items.filter((item) => !known.has(item.correctionId)).map((item) => listed(item));
  return [...held, ...fresh];
};
