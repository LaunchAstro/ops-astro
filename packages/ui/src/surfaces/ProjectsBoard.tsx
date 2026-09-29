// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board (MP-5-8): a stub, red before the board.

import type { ReactElement } from 'react';
import type { ProjectRow } from '../board/projects.ts';

export interface ProjectsBoardProps {
  readonly rows: readonly ProjectRow[];
  readonly withheld?: number;
  readonly changedAt?: string | null;
  readonly stages: readonly string[];
  readonly href: (row: ProjectRow) => string;
  readonly address?: string;
  readonly onAddress?: (address: string) => void;
  readonly now?: Date;
  readonly width?: number;
  readonly viewport?: number;
}

export function ProjectsBoard(props: ProjectsBoardProps): ReactElement {
  return <div data-stub={props.rows.length} />;
}
