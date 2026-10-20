// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's and R5's handlers, spread whole into `handlers.ts` for its line cap.

import { decideLiveCorrection, requestLiveCorrection, setApprover } from './live-corrections.ts';
import { recordReview, setSingleOperator } from './live-correction-review.ts';
import { askLiveRevert } from './live-correction-revert-ask.ts';
import type { Handler } from './handler-types.ts';

type Name =
  | 'live_correction.request'
  | 'live_correction.decide'
  | 'live_correction.record_review'
  | 'live_correction.revert'
  | 'settings.set_live_correction_approver'
  | 'settings.set_single_operator';

export const LIVE_CORRECTION_HANDLERS: { readonly [K in Name]: Handler<K> } = {
  'live_correction.request': requestLiveCorrection,
  'live_correction.decide': decideLiveCorrection,
  'live_correction.record_review': recordReview,
  'live_correction.revert': askLiveRevert,
  'settings.set_live_correction_approver': setApprover,
  'settings.set_single_operator': setSingleOperator,
};
