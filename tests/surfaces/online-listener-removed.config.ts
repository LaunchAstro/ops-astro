// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config.ts';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    setupFiles: [
      ...(base.test?.setupFiles ?? []),
      'tests/surfaces/online-listener-removed.setup.ts',
    ],
  },
});
