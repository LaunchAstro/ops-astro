// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox inside Tasks (INB-1g). Skeleton: draws nothing yet.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export interface InboxProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly go?: (href: string) => void;
}

export function Inbox(_props: InboxProps): ReactElement {
  return <section className="card inbox" />;
}
