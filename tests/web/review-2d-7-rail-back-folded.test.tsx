// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-2D-7: rail-collapse.test.tsx claims "the way back included", but its
// clients:back fixture carries no `kind: 'back'`, so Shell draws it as an
// ordinary section and never draws `.rail__back` at all. The real way back
// (route-views.tsx, `kind: 'back'`) is drawn by Shell as `.rail__back`. Folded,
// it must keep its hover title and its chevron, and its label must be hidden
// from sight only, clipped by the collapsed rail's rule.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import { drawn, shell, unmountAll } from './rail-app.tsx';

const SHEET = readFileSync('packages/ui/src/styles/3-shell.css', 'utf8');

afterEach(unmountAll);

describe('REVIEW-2D-7: the real way back, folded', () => {
  it('REVIEW-2D-7: .rail__back keeps its title and chevron and its .rail__label is clipped while folded', async () => {
    const page = await drawn(
      <Shell
        face="client"
        build={null}
        rail={[
          { id: 'clients:back', label: 'Back to Clients', href: '/clients/', kind: 'back' },
          { id: 'clients:overview', label: 'Overview', href: '/clients/a/' },
          { id: 'clients:tasks', label: 'Tasks', href: '/clients/a/tasks/' },
        ]}
        here="/clients/a/"
        title="Overview"
        dock={null}
        railCollapsed
        railWidth={224}
      >
        {null}
      </Shell>,
    );
    expect(shell(page).dataset['rail']).toBe('collapsed');
    // The way back is its own button, not one of the sections.
    expect(page.all('.rail__group .rail__item')).toHaveLength(2);
    const back = page.find('.rail__back');
    expect(back, 'a kind:back entry draws .rail__back').not.toBeNull();
    expect(back?.getAttribute('href')).toBe('/clients/');
    expect(back?.getAttribute('title'), 'the folded way back keeps its name on hover').toBe(
      'Back to Clients',
    );
    const chevron = back?.querySelector('svg');
    expect(chevron, 'the folded way back keeps its chevron').not.toBeNull();
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
    expect(back?.querySelector('.rail__label')?.textContent).toBe('Back to Clients');
    // The label is hidden from sight in the strip, not removed, and nothing
    // scoped to the way back undoes the clip.
    expect(SHEET).toMatch(
      /\.shell\[data-rail='collapsed'\] \.rail__label\s*\{[^}]*clip-path: inset\(50%\)/u,
    );
    expect(SHEET).not.toMatch(/\.rail__back[^{]*\.rail__label\s*\{[^}]*clip-path:\s*none/u);
  });
});
