// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's before and after (#2105): what changed at each width between the previous revision's
// landed observation and this one's, by C80's own comparison (`core-connectors`' captures).
// A width compares only once it has landed on both revisions, so a first revision, or a width
// not yet landed on either, has no difference.

import type { CaptureView, ReviewView } from '../../../core-records/src/index.ts';
import { changedStylesheets, changedText } from '../../../core-connectors/src/index.ts';
import type { WidthDifference } from '../../../core-wire/src/index.ts';
import { isObservation } from '../commands/review-captures.ts';

const landedObservation = (capture: CaptureView | undefined) =>
  capture?.state === 'landed' && isObservation(capture.observation)
    ? capture.observation
    : undefined;

/** Each width landed on both the revision before and the one under review, widest first. */
export function differencesOf(review: ReviewView): readonly WidthDifference[] {
  const { before, after } = review;
  if (before === null || after === null) return [];
  return after.captures.flatMap((capture) => {
    const now = landedObservation(capture);
    const then = landedObservation(before.captures.find((was) => was.width === capture.width));
    if (now === undefined || then === undefined) return [];
    return [
      {
        width: capture.width,
        text: changedText(then.text, now.text),
        stylesheets: changedStylesheets(then.stylesheets, now.stylesheets),
      },
    ];
  });
}
