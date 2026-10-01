// From the take's interim review (5930cc2): 779641f turned the agent pane's
// "No checks recorded yet." from PaneEmpty into the inline Empty, but the
// web render pins still hold PaneEmpty's markup, so web-render-pins is red.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Empty } from '../../packages/ui/src/primitives/Absence.tsx';

const pins = readFileSync(
  new URL('../surfaces/__snapshots__/web-render-pins.test.tsx.snap', import.meta.url),
  'utf8',
);

describe('SL12 take join', () => {
  it('the render pins hold the empty state the evidence section now draws', () => {
    const drawn = renderToStaticMarkup(<Empty look="inline" title="No checks recorded yet." />);

    expect(pins).not.toContain('data-voice="no-rows">No checks recorded yet.</p>');
    expect(pins).toContain(drawn);
  });
});
