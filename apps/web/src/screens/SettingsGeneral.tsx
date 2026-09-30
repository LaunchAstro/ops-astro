// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings`: Settings General (MP-2-11). Three groups on one page, in the
// mockup's row pattern: You and Notifications (the person's own, in
// `settings/you.tsx`) and This business, which is the built settings screen
// (`Settings.tsx`) unchanged: its two rows, their revision and refusal
// handling and their capability gating. The conversation and retention
// windows join This business when their commands land.

import type { ReactElement } from 'react';
import { SettingsScreen, type SettingsScreenProps } from './Settings.tsx';
import { YouGroups } from './settings/you.tsx';

export function SettingsGeneralScreen(props: SettingsScreenProps): ReactElement {
  return (
    <div className="stack" data-screen="settings-general">
      <YouGroups client={props.client} grantKey={props.grantKey} storage={props.storage} />
      <section className="sb__sect" data-pref="business">
        <div className="sb__sh">
          <span className="sb__k">This business</span>
        </div>
        <SettingsScreen {...props} />
      </section>
    </div>
  );
}
