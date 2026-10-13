// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A standing approval form while its filing is in flight (#1427). The
// sentence is locked until the answer lands, so no newer draft is lost; every
// other field the person can still change must be locked too, or kept once
// the answer clears the form.

import { afterEach, expect, it } from 'vitest';
import {
  fill,
  filings,
  regionOn,
  stubServer,
  tick,
  unmountOpened,
  valueOf,
} from './graduation-draft-server.tsx';

afterEach(unmountOpened);

it('a field changed while its filing is in flight is locked, or kept once the answer lands', async () => {
  const gate: { release?: () => void } = {};
  const hold = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const stub = stubServer({ hold });
  const page = await regionOn(stub);
  await fill(page);
  await page.click('[data-mandate-add]');
  await tick();
  const changes: readonly (readonly [string, string])[] = [
    ['[data-mandate-ceiling]', '750'],
    ['[data-mandate-expiry]', '2030-11-30'],
  ];
  const locked = new Map<string, boolean>();
  for (const [selector, value] of changes) {
    const field = page.host.querySelector<HTMLInputElement>(selector);
    locked.set(selector, field?.disabled === true);
    // eslint-disable-next-line no-await-in-loop -- one field at a time, as a person types
    if (field?.disabled !== true) await page.type(selector, value);
  }
  gate.release?.();
  await tick();
  expect(filings(stub)).toHaveLength(1);
  const kept = changes.map(([selector, value]) => [
    selector,
    locked.get(selector) === true || valueOf(page, selector) === value,
  ]);
  expect(kept).toStrictEqual(changes.map(([selector]) => [selector, true]));
});
