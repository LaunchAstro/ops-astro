// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): every piece of the kit, once, in each of its
// drawn states, keyed by its catalogue id. The gallery test compares these ids
// with the catalogue's list, so a primitive that is built but not shown, or
// catalogued but not built, fails.
//
// A state here is one the markup draws (disabled, pressed, checked, open, an
// error). Hover and keyboard focus are real pointer and keyboard states; the
// width-and-theme harness (MP-1-7) drives them on the entries marked
// `interactive` rather than the gallery faking them with extra rules.
//
// It draws sample words only, never a record.
//
// The entries live beside this file, one module per part of the kit, and
// join here in catalogue order.

import type { ReactElement } from 'react';
import type { GalleryEntry } from './gallery-entry.ts';
import { BLOCKS } from './gallery-layout.tsx';
import { FEEDBACK } from './gallery-feedback.tsx';
import { MARKS } from './gallery-marks.tsx';
import { CHARTS } from './gallery-charts.tsx';
import { CONTROLS } from './gallery-controls.tsx';
import { TREATMENTS } from './gallery-treatments.tsx';

export type { GalleryEntry, GalleryState } from './gallery-entry.ts';

export const GALLERY: readonly GalleryEntry[] = [
  ...CONTROLS,
  ...MARKS,
  ...BLOCKS,
  ...FEEDBACK,
  ...CHARTS,
  ...TREATMENTS,
];

/** The gallery page. */
export function Gallery(): ReactElement {
  return (
    <div className="gallery">
      <h1 className="gallery__title">Component gallery</h1>
      {GALLERY.map((entry) => (
        <section
          key={entry.id}
          className="gallery__entry"
          data-catalogue-id={entry.id}
          aria-labelledby={`g-${entry.id}`}
        >
          <h2 className="gallery__name" id={`g-${entry.id}`}>
            {entry.name} <span className="stamp">{entry.id}</span>
          </h2>
          <div className="gallery__states">
            {entry.states.map((state) => (
              <figure key={state.label} className="gallery__state" data-gallery-state={state.label}>
                <figcaption className="stamp">{state.label}</figcaption>
                {state.render()}
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
