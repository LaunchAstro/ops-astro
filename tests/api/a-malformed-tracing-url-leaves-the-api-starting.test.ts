// SPDX-License-Identifier: AGPL-3.0-only
//
// Tracing is optional. A `LANGFUSE_HOST` that is not a URL builds a tracing
// source that never calls out and reads as malformed in the operations view,
// with one warning naming the setting and never its value, so the API still
// starts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLangfuseHealth } from '../../apps/api/health/tracing.ts';

/** No scheme at all, and a scheme with nothing a path can be joined to. */
const SETTINGS = ['langfuse.internal', 'langfuse.internal:not a url'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a malformed tracing URL', () => {
  it.each(SETTINGS)(
    '%s builds a source that reads as malformed, calls nothing and warns without the value',
    async (setting) => {
      const warned: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((line: string) => {
        warned.push(line);
      });
      const calls: unknown[] = [];
      const build = () =>
        createLangfuseHealth({
          baseUrl: setting,
          fetch: async (...args) => {
            calls.push(args);
            return await Promise.resolve(new Response('{"status":"OK"}'));
          },
        });
      expect(build).not.toThrow();
      await expect(build().observe()).resolves.toStrictEqual({ ok: false, fault: 'malformed' });
      expect(calls).toStrictEqual([]);
      expect(warned.join('\n')).toMatch(/LANGFUSE_HOST/u);
      expect(warned.join('\n')).not.toContain('langfuse.internal');
    },
  );
});
