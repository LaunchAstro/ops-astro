// SPDX-License-Identifier: AGPL-3.0-only
//
// Detail levels and pages for the task reads (API-3, CS-15.19). Its named
// tests come first: no read takes a level or a page yet.

import { QUOTAS } from '../../../core-records/src/index.ts';
import type { QuotaLimits } from '../../../core-records/src/index.ts';

export const PAGE_SIZE: QuotaLimits['pageSize'] = QUOTAS.pageSize;
