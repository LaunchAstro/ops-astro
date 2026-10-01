// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1's owner check on a built page: the Work log carries a section tip,
// the page kit's SectionTip fed by the one preference store. The tip shows
// from `preference.read`; dismissing it sends `preference.dismiss_tip` and
// hides it; a reload whose store holds that version draws no tip, a higher
// version comes back, and tips off draws none. The store's own lines (one
// entry per page and tip, isolation, no audit) are MP-2-11's and
// `mp-9-1-tip-dismiss-security`'s.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, json, openWorkLog, pinZone, projects, tick } from './work-log-stand-in.tsx';

pinZone();

/** The Work log's tip as the store names it: its page's route id, its id and version 1. */
const WORK_LOG_TIP = { page: 'agency:projects-board', id: 'work-log', version: 1 } as const;

const TIP = '.sectip';
const DISMISS = '.sectip button[aria-label="Dismiss this tip"]';

/** A stand-in that answers the board, the ledger and the two preference calls. */
function server(preferences: Readonly<Record<string, unknown>> | null, dismissStatus = 200) {
  const asked: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), 'http://api.test').pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (path.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (path.endsWith('/task/ledger')) return Promise.resolve(json(FIRST));
    asked.push({ path, body });
    if (path.endsWith('/preference/read')) {
      return preferences === null
        ? Promise.reject(new Error('the store is unreachable'))
        : Promise.resolve(json({ ok: true, preferences }));
    }
    if (path.endsWith('/preference/dismiss_tip')) {
      return Promise.resolve(
        dismissStatus === 200
          ? json({ ok: true })
          : json({ refused: true, code: 'FIELD_VALUE_INVALID', names: ['tip'], fixes: [] }, 422),
      );
    }
    return Promise.reject(new Error(`unrouted ${path}`));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const dismissedAt = (version: number) => ({
  'tips.dismissed': { [`${WORK_LOG_TIP.page}#${WORK_LOG_TIP.id}`]: version },
});

// eslint-disable-next-line max-lines-per-function -- one stand-in store, and the cases that share it
describe('MP-9-1 section tip on a built page', () => {
  it('the Work log shows its tip from the preference store, as the kit draws it', async () => {
    const api = server({});
    const view = await mount(projects(api.fetch));
    await openWorkLog(view);
    expect(view.find(`${TIP} .banner.banner--info .banner__body`)?.textContent).toMatch(/\S/u);
    // The one preference call the tip makes is the store's own read.
    expect(
      api.asked.map((call) => call.path).filter((path) => path.includes('/preference/')),
    ).toEqual(['/api/b/alpha/preference/read']);
    await view.unmount();
  });

  it('dismissing sends exactly preference.dismiss_tip for this page, tip and version, and hides it', async () => {
    const api = server({});
    const view = await mount(projects(api.fetch));
    await openWorkLog(view);
    await view.click(DISMISS);
    await tick();
    expect(view.find('.sectip')).toBeNull();
    const sent = api.asked.filter((call) => call.path.endsWith('/preference/dismiss_tip'));
    expect(sent).toHaveLength(1);
    const { operationId, ...operands } = sent[0]?.body ?? {};
    expect(typeof operationId).toBe('string');
    expect(operands).toEqual({ page: WORK_LOG_TIP.page, tip: WORK_LOG_TIP.id, version: 1 });
    await view.unmount();
  });

  it('a reload whose store holds that version draws no tip; a higher version comes back', async () => {
    const same = await mount(projects(server(dismissedAt(WORK_LOG_TIP.version)).fetch));
    await openWorkLog(same);
    expect(same.find('.act__row')).not.toBeNull();
    expect(same.find('.sectip')).toBeNull();
    await same.unmount();

    const older = await mount(projects(server(dismissedAt(WORK_LOG_TIP.version - 1)).fetch));
    await openWorkLog(older);
    expect(older.find('.sectip')).not.toBeNull();
    await older.unmount();
  });

  it('tips off draws no tip, and a store that cannot be read draws none either', async () => {
    const off = await mount(projects(server({ 'tips.enabled': false }).fetch));
    await openWorkLog(off);
    expect(off.find('.sectip')).toBeNull();
    await off.unmount();

    const down = await mount(projects(server(null).fetch));
    await openWorkLog(down);
    expect(down.find('.act__row')).not.toBeNull();
    expect(down.find('.sectip')).toBeNull();
    await down.unmount();
  });

  it('a refused dismissal leaves the tip hidden in this view and is not sent again', async () => {
    const api = server({}, 422);
    const view = await mount(projects(api.fetch));
    await openWorkLog(view);
    await view.click(DISMISS);
    await tick();
    await tick();
    expect(view.find('.sectip')).toBeNull();
    expect(api.asked.filter((call) => call.path.endsWith('/preference/dismiss_tip'))).toHaveLength(
      1,
    );
    await view.unmount();
  });
});
