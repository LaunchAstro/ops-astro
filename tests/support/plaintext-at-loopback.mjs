// SPDX-License-Identifier: AGPL-3.0-only
//
// Test-only, loaded with `--import` beside `pooler-at-loopback.mjs` into a
// process a test spawns. The throwaway database serves no TLS, so this marks
// the process as allowed to reach it in plain text; the address it is given
// still says `sslmode=require` and is judged as on staging. Nothing outside a
// test sets the mark: it is not a setting, and no environment reaches it.

globalThis[Symbol.for('ops-astro.test.plaintext-at-loopback')] = true;
