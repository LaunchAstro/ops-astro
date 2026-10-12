// SPDX-License-Identifier: AGPL-3.0-only
//
// The pin check reads each `${NAME:-default}` in the model as its default,
// so the run must give Compose no other value for it. A raw event prefix
// inherited from the shell would move uploads outside the 14-day rule the
// check proved (contract 7.2.1); a password from the shell would override
// the settings file. Compose takes neither: each name the model reads comes
// from the settings file or its default.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { traceTarget } from './trace-target-stub.fixture.ts';

const target = traceTarget();
afterAll(() => target.remove());

const MODEL = resolve(
  import.meta.dirname,
  '../../scripts/local/trace-target/profile.resolved.json',
);

it('up gives Compose no name the model reads from the shell it was started in', () => {
  const read = new Set(
    [...readFileSync(MODEL, 'utf8').matchAll(/\$\{([A-Z0-9_]+)/gu)].map(([, name]) => name),
  );
  expect(read).toContain('LANGFUSE_S3_EVENT_UPLOAD_PREFIX');
  target.run(['up', '3910'], {
    LANGFUSE_S3_EVENT_UPLOAD_PREFIX: 'raw/',
    LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: 'https://bucket.example.test',
    TRACE_TARGET_POSTGRES_PASSWORD: 'from-the-shell',
  });
  const inherited = target
    .upEnvironment()
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((name) => read.has(name));
  expect(inherited).toEqual([]);
});
