// SPDX-License-Identifier: AGPL-3.0-only
//
// A test-only preload (`node --import`) for a spawned command line: every
// fetch is written to the file `FETCH_RECORD` names, then refused, so a test
// can show a run sent nothing. Only the address is recorded, never a header.

import { appendFileSync } from 'node:fs';

globalThis.fetch = (input) => {
  const address = input instanceof Request ? input.url : String(input);
  appendFileSync(process.env.FETCH_RECORD ?? '', `${address}\n`);
  return Promise.reject(new TypeError('fetch refused by the test preload'));
};
