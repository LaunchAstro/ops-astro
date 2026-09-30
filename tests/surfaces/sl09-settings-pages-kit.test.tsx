// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// SL09's two settings pages, Access and Telemetry, laid out in the placeholder
// page's kit (PAGE-MAP SH-40 to 44): the page title is the top bar's alone, and
// the body is sections, each a section head over content cards in one stack.
// `tests/visual/look/access.ts` and `telemetry.ts` hold the same parts to the
// mockup's measured look; these cases hold the markup the probes read.

import { afterEach, describe, expect, it } from 'vitest';
import { ADA, MIA, access, json, open, server, unmountAll } from './access-screen-world.tsx';

afterEach(unmountAll);

const HEALTH = {
  ok: true,
  privacyIncidents: [],
  breachRunbook: null,
  serviceHealth: {
    checkedAt: '2026-09-30T08:00:00.000Z',
    sources: [{ source: 'watcher', state: 'read', fault: null }],
    services: [
      { source: 'watcher', name: 'api', state: 'healthy', lastObservedAt: '2026-09-30T07:59:00Z' },
    ],
  },
};

const heads = (root: Element | null): string[] =>
  [...(root?.querySelectorAll('h1, h2, .sec__head') ?? [])].map((each) => each.textContent ?? '');

describe('SL09 settings pages in the page kit', () => {
  it('Access: the top bar alone names the page; the lists sit under one section head', async () => {
    const view = await open(server([json(access([ADA, MIA]))]).fetch);
    const page = view.find('[data-screen="access"]');
    expect(page?.querySelector('.tpr')).toBeNull();
    expect(heads(page)).not.toContain('Access');
    expect(page?.querySelector('section.sec > h2.sec__head')?.textContent).toBe('Who may do what');
    const lists = view.find('[data-access-lists]');
    expect(lists?.classList.contains('stack')).toBe(true);
    for (const id of ['team', 'clients', 'agents'])
      expect(lists?.querySelector(`[data-access="${id}"] .card`)).not.toBeNull();
    // Give access is its own section: a lone content card, as the page kit's last one.
    expect(view.find('section.sec > [data-access="give"] .card')).not.toBeNull();
  });

  it('Telemetry: one section head, the sources and the services each their own titled card', async () => {
    const api = server([], () => json(HEALTH));
    const view = await open(api.fetch, '/settings/telemetry/');
    const page = view.find('[data-screen="telemetry"]');
    expect(page?.querySelector('.tpr')).toBeNull();
    expect(heads(page)).not.toContain('Telemetry');
    expect(page?.querySelector('section.sec > h2.sec__head')?.textContent).toBe('Service health');
    const cards = view.find('[data-health-cards]');
    expect(cards?.classList.contains('stack')).toBe(true);
    expect(cards?.querySelector('[data-health="sources"] .card .card__title')?.textContent).toBe(
      'Sources',
    );
    expect(cards?.querySelector('[data-health="services"] .card .card__title')?.textContent).toBe(
      'Services',
    );
  });
});
