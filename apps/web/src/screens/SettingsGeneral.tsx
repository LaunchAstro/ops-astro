// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings`: Settings General (MP-2-11). Four groups on one page, each the
// mockup's settings card (AG-X20) of rows, a content gap apart: You and
// Notifications (the person's own, in `settings/you.tsx`), Your AI agents
// (`settings/agents.tsx`) and This business, which is the built settings screen
// (`Settings.tsx`): the four-eyes, client sign-off, conversation window and
// retention window rows, their revision and refusal handling and their
// capability gating.

import type { ReactElement } from 'react';
import { SettingsScreen, type SettingsScreenProps } from './Settings.tsx';
import { YouGroups } from './settings/you.tsx';
import { AgentsGroup } from './settings/agents.tsx';

export function SettingsGeneralScreen(props: SettingsScreenProps): ReactElement {
  return (
    <div className="stack settings__page" data-screen="settings-general">
      <YouGroups client={props.client} grantKey={props.grantKey} storage={props.storage} />
      <AgentsGroup client={props.client} grantKey={props.grantKey} />
      <div data-pref="business">
        <SettingsScreen {...props} />
      </div>
    </div>
  );
}
