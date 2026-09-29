// SPDX-License-Identifier: AGPL-3.0-only
//
// The description and the agent brief (MP-4-7). A typed stub until the
// fields land: each draws nothing and writes nothing.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export interface TextFieldProps {
  readonly client: OperationsClient;
  readonly recordId: string;
  readonly revision: number;
  readonly value: string | null;
  readonly onSaved: () => void;
}

export function DescriptionField(_props: TextFieldProps): ReactElement {
  return <div />;
}

export function BriefField(_props: TextFieldProps): ReactElement {
  return <div />;
}
