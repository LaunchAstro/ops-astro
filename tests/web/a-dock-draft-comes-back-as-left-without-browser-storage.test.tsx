// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A browser that keeps no site data still brings the new-task draft back as
// it was left when another door remounts it: the tab's own copy stands in.

import { afterEach, describe, expect, it } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { ADA, NO_CLIENT, server } from './draft-support.tsx';
import { mount, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(async () => {
  await unmountAll();
  dropOtherDrafts(null, null);
});

const panel = (client = server().client) => (
  <DraftPanel
    client={client}
    storage={null}
    person={ADA}
    scope={NO_CLIENT}
    onCreated={() => {}}
    onClose={() => {}}
    docked
    hold={() => () => true}
  />
);

describe('a dock draft with no browser storage', () => {
  it('comes back with its typed name when another door remounts it', async () => {
    const first = await mount(panel());
    await tick();
    await typeInto(first, '#panel-draft-name', 'Call the venue');
    await first.unmount();
    const again = await mount(panel());
    await tick();
    expect((again.find('#panel-draft-name') as HTMLInputElement | null)?.value).toBe(
      'Call the venue',
    );
  });
});
