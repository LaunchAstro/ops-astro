// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// R60: the description is sans everywhere; mono is kept for the Agent side's
// brief alone. The description field is mounted in its real dock task panel
// (`.dtp`) and drawn under the app's whole cascade, and the family read is the
// textarea's own. This replaces Sol's OW-130 dock case, whose sans reference
// sits inside the textarea, where Chromium computes no style for it.

import { afterEach, expect, it } from 'vitest';
import { drawnStyle } from './app-cascade.ts';
import { panel, serving } from './panel-fields-support.tsx';
import { unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

it('the description field in the dock task panel is drawn in the sans stack', async () => {
  const view = await panel(serving({ description: 'Description in the actual panel' }).client);
  expect(view.find('.dtp textarea[data-writing="description"]')).not.toBeNull();
  const fonts = await drawnStyle(
    view.host.innerHTML,
    'font-family',
    { description: '.dtp textarea[data-writing="description"]' },
    { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
  );
  expect(fonts['sans']).not.toBe(fonts['mono']);
  expect(fonts['description']).toBe(fonts['sans']);
}, 30_000);
