// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The five renderings, and the one assertion that matters most: **none of them
// draws data the read did not return.**
//
// Each test checks the outcome stamp, what a person reads, and — for the three
// that are not `ready` — that the rows are absent from the document. A denied
// read that quietly rendered the last good rows would pass a test that only
// looked for the words "not permitted", so the absence is asserted directly.

import { describe, expect, it } from 'vitest';
import { RecordState } from '../../apps/web/src/views/record-state.tsx';
import type { ReadState } from '../../apps/web/src/data/authorised-read.ts';
import { mount } from './mount.tsx';

interface Rows {
  readonly rows: readonly string[];
}

const GRANT = 'alpha:tok';

const base: ReadState<Rows> = {
  outcome: 'loading',
  value: null,
  refusal: null,
  because: null,
  grantKey: GRANT,
};

const draw = (state: ReadState<Rows>) => (
  <RecordState state={state} subject="board">
    {(value) => (
      <ul>
        {value.rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    )}
  </RecordState>
);

describe('the five renderings', () => {
  it('loading says so, politely, and draws no rows', async () => {
    const view = await mount(draw(base));
    expect(view.find('[data-outcome="loading"]')).not.toBeNull();
    expect(view.find('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(view.all('li')).toHaveLength(0);
    await view.unmount();
  });

  it('ready draws the rows it was given', async () => {
    const view = await mount(draw({ ...base, outcome: 'ready', value: { rows: ['one', 'two'] } }));
    expect(view.find('[data-outcome="ready"]')).not.toBeNull();
    expect(view.all('li').map((row) => row.textContent)).toEqual(['one', 'two']);
    await view.unmount();
  });

  it("denied quotes the server's own code and draws no rows", async () => {
    const view = await mount(
      draw({
        ...base,
        outcome: 'denied',
        refusal: {
          refused: true,
          code: 'SCOPE_NOT_GRANTED',
          names: ['task'],
          fixes: ['Ask an administrator for the task scope.'],
        },
      }),
    );
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.find('[role="alert"]')).not.toBeNull();
    // Verbatim by code: a person can quote this to somebody who can act on it.
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.text()).toContain('Ask an administrator for the task scope.');
    expect(view.all('li')).toHaveLength(0);
    await view.unmount();
  });

  it('unavailable says nothing was decided, and offers the retry', async () => {
    let retried = 0;
    const view = await mount(
      <RecordState
        state={{ ...base, outcome: 'unavailable', because: 'The API did not answer.' }}
        subject="board"
        onRetry={() => {
          retried += 1;
        }}
      >
        {() => <ul />}
      </RecordState>,
    );
    expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(view.text()).toContain('The API did not answer.');
    expect(view.text()).toContain('Nothing has been decided about your access.');
    await view.click('button');
    expect(retried).toBe(1);
    await view.unmount();
  });

  it('empty is its own voice and is not an apology', async () => {
    const view = await mount(draw({ ...base, outcome: 'empty', value: { rows: [] } }));
    const empty = view.find('[data-outcome="empty"]');
    expect(empty).not.toBeNull();
    // The no-rows voice, not the input-wrong one and not the not-built one.
    expect(view.find('[data-voice="no-rows"]')).not.toBeNull();
    expect(view.find('[role="alert"]')).toBeNull();
    await view.unmount();
  });
});

describe('denied and empty are distinguishable', () => {
  it('reads differently to a person, which is the whole of N2', async () => {
    const deniedView = await mount(
      draw({
        ...base,
        outcome: 'denied',
        refusal: { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
      }),
    );
    const deniedText = deniedView.text();
    await deniedView.unmount();

    const emptyView = await mount(draw({ ...base, outcome: 'empty', value: { rows: [] } }));
    const emptyText = emptyView.text();
    await emptyView.unmount();

    expect(deniedText).not.toBe(emptyText);
    expect(deniedText).toContain('not permitted');
    expect(emptyText).not.toContain('not permitted');
  });
});

describe('ready with no value', () => {
  it('says the product is wrong about itself rather than drawing an empty screen', async () => {
    const view = await mount(draw({ ...base, outcome: 'ready', value: null }));
    expect(view.find('[data-voice="not-built"]')).not.toBeNull();
    await view.unmount();
  });
});
