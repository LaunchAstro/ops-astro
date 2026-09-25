// SPDX-License-Identifier: AGPL-3.0-only
//
// The race a grant change opens: an old read that resolves after a new denial.
//
// `useRead` re-runs its effect when the grant key changes, and the read the
// previous effect started is still in flight. The cleanup used to clear the
// reference and leave the old projection holding `setState`, so a success that
// arrived late drew the old grant's rows over the new grant's denial. The
// projection is retired now, and this is the case that says so.

// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import type { CallResult } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

interface Rows {
  readonly rows: readonly string[];
}

const DENIED: CallResult<Rows> = {
  refused: true,
  code: 'SCOPE_NOT_GRANTED',
  names: [],
  fixes: [],
};

describe('useRead across a grant change', () => {
  it('does not let the old grant’s read land on the new grant’s denial', async () => {
    let releaseOld: ((result: CallResult<Rows>) => void) | undefined;
    let changeGrant: (() => void) | undefined;

    function Probe(): ReactElement {
      const [grantKey, setGrantKey] = useState('old-grant');
      changeGrant = () => {
        setGrantKey('new-grant');
      };
      const { state } = useRead<Rows>({
        grantKey,
        run: async () =>
          grantKey === 'old-grant'
            ? await new Promise<CallResult<Rows>>((resolve) => {
                releaseOld = resolve;
              })
            : DENIED,
        deps: [],
      });
      return <p data-outcome={state.outcome}>{state.outcome}</p>;
    }

    const screen = await mount(<Probe />);
    expect(releaseOld).toBeDefined();
    expect(screen.find('[data-outcome]')?.getAttribute('data-outcome')).toBe('loading');

    // The grant changes. The new read is denied while the old one is still out.
    await act(async () => {
      changeGrant?.();
    });
    expect(screen.find('[data-outcome]')?.getAttribute('data-outcome')).toBe('denied');

    // The old read finally answers, carrying rows the old grant could see.
    await act(async () => {
      releaseOld?.({ ok: true, value: { rows: ['the old grant’s row'] } });
    });

    expect(screen.find('[data-outcome]')?.getAttribute('data-outcome')).toBe('denied');
    expect(screen.text()).not.toContain('the old grant’s row');
    await screen.unmount();
  });
});
