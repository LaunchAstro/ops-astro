// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { crossingDeclared } from '../../apps/web/src/manifest.ts';
import { open } from './mp-2-1-support.tsx';

it('no legacy address appears in the interface', async () => {
  const { view } = await open('/agency/unknown-page/');
  try {
    expect(view.text()).not.toContain('/agency/unknown-page/');
  } finally {
    await view.unmount();
  }
});

it('an undeclared Hub-to-portal link fails the manifest check', () => {
  expect(crossingDeclared('agency', '/portal/acme-dental/unknown-page/')).toBe(false);
});
