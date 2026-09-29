// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view (WF-3). Not built yet: a typed stub so its named tests fail on
// behaviour, not on a missing module.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export interface MapScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly mapKey: string;
}

export function MapScreen(_props: MapScreenProps): ReactElement {
  return <section data-map-refused="">not built</section>;
}
