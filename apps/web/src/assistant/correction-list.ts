// SPDX-License-Identifier: AGPL-3.0-only
//
// #1695: a desk's cards as `live_correction.list` answers them. A card the
// desk holds takes the listed state; a correction it does not hold yet is
// added, its page named by its address.
//
// #2108: the list names a version but not its check. A card listed at a new
// version drops the check it held on the old one, so it offers no Approve
// until a read of the new version answers.

import type { CorrectionListItem } from '../../../../packages/core-wire/src/index.ts';
import { cardState } from './correction.ts';
import type { Correction } from './correction-desks.ts';

/** A held card as the list answered it: a new version keeps no check from the old one. */
const standing = (held: Correction, item: CorrectionListItem): Correction => ({
  ...held,
  state: cardState(item.state),
  approver: item.approver,
  versionId: item.versionId,
  refusal: null,
  launchHeld: false,
  ...(item.versionId === held.versionId ? {} : { verifiedForMs: 0, readAt: null }),
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
  launchHeld: false,
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
    return item === undefined ? each : standing(each, item);
  });
  const known = new Set(list.map((each) => each.correctionId));
  const fresh = items.filter((item) => !known.has(item.correctionId)).map((item) => listed(item));
  return [...held, ...fresh];
};
