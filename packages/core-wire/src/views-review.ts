// SPDX-License-Identifier: AGPL-3.0-only
//
// What the review reads answer (C35, #2011): one review with its revisions and their captures
// by width.

import type { ReviewView } from '../../core-records/src/index.ts';

export type { CaptureView as ReviewCaptureView } from '../../core-records/src/index.ts';

export interface ReviewReadResult {
  readonly ok: true;
  readonly review: ReviewView;
}
