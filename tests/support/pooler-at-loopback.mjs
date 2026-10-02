// SPDX-License-Identifier: AGPL-3.0-only
//
// Test-only, loaded with `--import` into a process a test spawns (and passed on
// to the processes it starts with its own flags). Supabase's pooler in Sydney
// resolves to the test's own database on loopback, and any other Supabase host
// fails to resolve, so nothing hosted is reached. The process still judges its
// addresses as it does on staging (`scripts/ops/staging-reset.ts`); only the
// name lookup is moved.

import dns from 'node:dns';

const POOLER = /^aws-[0-9]+-ap-southeast-2\.pooler\.supabase\.com$/u;
const lookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  if (POOLER.test(host)) return lookup('127.0.0.1', options, callback);
  if (/(?:^|\.)supabase\.(?:co|com)$/u.test(host)) {
    const done = typeof options === 'function' ? options : callback;
    const error = Object.assign(new Error(`${host} is not served in this test`), {
      code: 'ENOTFOUND',
    });
    return process.nextTick(() => done(error));
  }
  return lookup(host, options, callback);
};
