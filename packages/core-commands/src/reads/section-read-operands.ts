// SPDX-License-Identifier: AGPL-3.0-only
//
// The section reads' operands and answers (Review, Docs), joined into `ReadOperands` and
// `ReadResult` in `requests.ts` through one name each, which keeps that file under its line cap.

import type { DocsReadOperands, DocsReadsResult } from './docs-read-operands.ts';
import type { ReviewReadOperands, ReviewReadsResult } from './review-read-operands.ts';

export interface SectionReadOperands extends ReviewReadOperands, DocsReadOperands {}

export type SectionReadsResult = ReviewReadsResult | DocsReadsResult;
