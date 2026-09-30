// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { SettingsScreen, type SettingsScreenProps } from './Settings.tsx';

export function SettingsGeneralScreen(props: SettingsScreenProps): ReactElement {
  return <SettingsScreen {...props} />;
}
