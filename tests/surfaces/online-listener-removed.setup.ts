// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, vi } from 'vitest';
let removed = 0;
beforeAll(() => {
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'online') {
      removed += 1;
      return;
    }
    add(type, listener, options);
  });
});
afterAll(() => {
  expect(removed).toBeGreaterThan(0);
  vi.restoreAllMocks();
});
