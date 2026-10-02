// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A view a test leaves mounted is unmounted when that test ends. Left mounted,
// a pending timer in it (Dock's 34 ms ready timer is one) rendered after the
// file's jsdom was torn down, and React's scheduler threw 'window is not
// defined' outside every test: a red run with every test green (#322, #324,
// #254's groups, 2 Oct). The first case leaves its view mounted on purpose;
// the second reads what is left of it.

import { useEffect, useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { mount, type Mounted } from './mount.tsx';

let left: Mounted | undefined;
let rendered = false;

function Late(): ReactElement {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      rendered = true;
      setLate(true);
    }, 20);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return <p>{late ? 'late' : 'first'}</p>;
}

describe('a mounted view is unmounted when its test ends', () => {
  it('leaves a view with a pending timer mounted', async () => {
    left = await mount(<Late />);
    expect(left.text()).toBe('first');
  });

  it('finds that view gone from the page and its timer never rendering', async () => {
    expect(left?.host.isConnected).toBe(false);
    await new Promise((done) => {
      setTimeout(done, 60);
    });
    expect(rendered).toBe(false);
  });
});
