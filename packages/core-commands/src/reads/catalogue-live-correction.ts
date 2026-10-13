// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's two read rows, spread into `READ_CATALOGUE` in `catalogue.ts` (kept
// apart for the 1,000-line cap).

import {
  parseCorrectionLocate,
  parseCorrectionRead,
  serveCorrectionLocate,
  serveCorrectionRead,
} from './live-correction.ts';
import type { ReadRow } from './read-row.ts';

type LiveCorrectionRead = 'live_correction.read' | 'live_correction.locate';

export const LIVE_CORRECTION_READ_ROWS: { readonly [K in LiveCorrectionRead]: ReadRow<K> } = {
  // C80: a correction's decision; `run:write` at its party, asked inside the query.
  'live_correction.read': {
    identifiers: ['correctionId'],
    parse: parseCorrectionRead,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    disclosed: (answer) => ('correction' in answer ? answer.correction.correctionId : undefined),
    serve: serveCorrectionRead,
  },
  // C80: the sidebar door's site read; what a request asks, asked inside the read.
  'live_correction.locate': {
    identifiers: ['recordId'],
    parse: parseCorrectionLocate,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    disclosed: (answer) => ('target' in answer ? answer.target.taskId : undefined),
    serve: serveCorrectionLocate,
  },
};
