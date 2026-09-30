// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-1 no-production-data suites' shared helpers
// (staging-no-production-data.test.ts and staging-no-production-data-guard.test.ts):
// the seed as a process, and the made-up and planted rows.

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const USERS_FILE: string = new URL('../../.local/synthetic-users.json', import.meta.url)
  .pathname;

export const MADE_UP: string[] = ['alpha', 'bravo'];
