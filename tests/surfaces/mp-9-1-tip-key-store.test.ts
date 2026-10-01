// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1, the page kit and the one preference store (an interim review finding). `core-wire/src/tips.ts` says the
// server and the page kit share one shape and one reading of the store: a
// dismissal is `tips.dismissed[page#tip] = version`, written only by
// `preference.dismiss_tip` with an integer version from 1. The page kit's
// SectionTip keys its dismissal `page#id@<text hash>` and hands `dismiss` that
// string, so a tip dismissed through the one command is never hidden by the
// kit, and the kit's dismissal cannot be sent to the command at all.

import { expect, it } from 'vitest';
import { tipKey as kitTipKey } from '../../packages/ui/src/index.ts';
import { tipKey, tipShown } from '../../packages/core-wire/src/tips.ts';

it('MP-9-1 the page kit names a dismissed tip as the one store keeps it', () => {
  const tip = { page: 'agency:inbox', id: 'inbox-owed', text: 'Owed items come first.' };
  // What preference.dismiss_tip stores for this tip, and the server's reading of it.
  const stored = { 'tips.dismissed': { [tipKey(tip.page, tip.id)]: 1 } };
  expect(tipShown(stored, { page: tip.page, tip: tip.id, version: 1 })).toBe(false);
  // The kit's key for the same tip must be the entry the store holds.
  expect(kitTipKey(tip)).toBe(tipKey(tip.page, tip.id));
});
