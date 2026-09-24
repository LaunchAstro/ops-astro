// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `useCommand`'s state, as a screen reads it (thermo recheck ND1). The hook
// returns `closed`, `locked`, `conflict` and `because`, so a screen no longer
// works them out again from `failure`. `closed` is sticky: once the server has
// said this reader may not make the write, `reset` does not reopen it.

import { useRef, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { CallResult, WireRefusal } from '../../apps/web/src/operations/client.ts';
import { useCommand } from '../../apps/web/src/records/use-command.ts';
import { mount } from './mount.tsx';

const refusal = (code: string): WireRefusal => ({
  refused: true,
  code,
  names: ['task'],
  fixes: ['Read the task again.'],
});

/** Each press answers the next reply in turn; one reply is held open. */
function Probe(props: {
  readonly replies: readonly (CallResult<unknown> | 'held')[];
}): ReactElement {
  const command = useCommand();
  const pressed = useRef(0);
  const press = (): void => {
    const reply = props.replies[pressed.current];
    pressed.current += 1;
    command.run(() =>
      reply === 'held' || reply === undefined
        ? new Promise<CallResult<unknown>>(() => {
            /* held open */
          })
        : Promise.resolve(reply),
    );
  };
  return (
    <div
      data-busy={String(command.busy)}
      data-closed={String(command.closed)}
      data-locked={String(command.locked)}
      data-conflict={command.conflict?.code ?? ''}
      data-because={command.because ?? ''}
    >
      <button type="button" data-press="" onClick={press} />
      <button type="button" data-reset="" onClick={command.reset} />
    </div>
  );
}

const state = (page: { find: (selector: string) => Element | null }) => {
  const probe = page.find('[data-busy]');
  return {
    busy: probe?.getAttribute('data-busy'),
    closed: probe?.getAttribute('data-closed'),
    locked: probe?.getAttribute('data-locked'),
    conflict: probe?.getAttribute('data-conflict'),
    because: probe?.getAttribute('data-because'),
  };
};

describe('useCommand', () => {
  it('starts open, with nothing to say', async () => {
    const page = await mount(<Probe replies={[]} />);
    expect(state(page)).toEqual({
      busy: 'false',
      closed: 'false',
      locked: 'false',
      conflict: '',
      because: '',
    });
    await page.unmount();
  });

  it('is locked while a write is in flight', async () => {
    const page = await mount(<Probe replies={['held']} />);
    await page.click('[data-press]');
    expect(state(page)).toMatchObject({ busy: 'true', closed: 'false', locked: 'true' });
    await page.unmount();
  });

  it('closes, and stays closed through reset, on an authority refusal', async () => {
    const page = await mount(<Probe replies={[refusal('SCOPE_NOT_GRANTED')]} />);
    await page.click('[data-press]');
    expect(state(page)).toMatchObject({ busy: 'false', closed: 'true', locked: 'true' });
    expect(state(page).because).toContain('SCOPE_NOT_GRANTED');
    await page.click('[data-reset]');
    expect(state(page)).toMatchObject({ closed: 'true', locked: 'true', because: '' });
    await page.unmount();
  });

  it('carries a stale refusal as the conflict, and reset clears it', async () => {
    const page = await mount(<Probe replies={[refusal('VERSION_STALE')]} />);
    await page.click('[data-press]');
    expect(state(page)).toMatchObject({
      closed: 'false',
      locked: 'false',
      conflict: 'VERSION_STALE',
    });
    await page.click('[data-reset]');
    expect(state(page)).toMatchObject({ conflict: '', because: '' });
    await page.unmount();
  });

  it('has no conflict for any other refusal, and stays open', async () => {
    const page = await mount(<Probe replies={[refusal('PROPOSAL_OUT_OF_SCOPE')]} />);
    await page.click('[data-press]');
    expect(state(page)).toMatchObject({ closed: 'false', locked: 'false', conflict: '' });
    expect(state(page).because).toContain('PROPOSAL_OUT_OF_SCOPE');
    await page.unmount();
  });
});
