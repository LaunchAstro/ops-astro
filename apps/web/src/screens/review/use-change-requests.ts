// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationsClient } from '../../operations/client.ts';

export type DockClient = Pick<OperationsClient, 'businessKey' | 'newOperationId' | 'read' | 'mutate'>;
