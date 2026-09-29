// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33): not built yet.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export function TriggersPanel(_props: { readonly client: OperationsClient }): ReactElement {
  return <section className="sb__sect" data-settings="triggers" />;
}
