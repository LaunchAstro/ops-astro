// SPDX-License-Identifier: AGPL-3.0-only
//
// One cell of the Projects board (MP-5-8, BOARDS P-20 to P-28, P-36; the name
// cell, with its tick, rename and hover box, is ProjectName.tsx, MP-5-9). The
// words come from `board/project-words.ts`; this draws them. The assignee, due
// and stage cells edit in place where the page hands in their command
// (MP-5-10, P-37; CellEditor.tsx). The estimate has no stored field to write
// yet (MP-4-8), so it draws no editor.

import type { ReactNode } from 'react';
import {
  burnOf,
  commentBadge,
  dueWords,
  estimateWords,
  rankCell,
  type ProjectRow,
  type RowActions,
} from '../board/projects.ts';
import { EditableCell } from './CellEditor.tsx';
import { ProjectName } from './ProjectName.tsx';

export interface CellContext {
  readonly now: Date;
  /** Where the row's record opens. */
  readonly href: (row: ProjectRow) => string;
  /** What the row can do (MP-5-9); none draws a read-only name. */
  readonly actions?: RowActions;
  /** The stages the stage editor offers, in order; none, no stage editor. */
  readonly stages?: readonly string[];
}

const UNASSIGNED = 'Unassigned';

const dash = (): ReactNode => <span className="cbd__dim">—</span>;

const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');

function Rank(props: { readonly row: ProjectRow }): ReactNode {
  const cell = rankCell(props.row);
  return (
    <span className={props.row.rank.number === null ? 'cbd__dim' : 'cbd__rank'} title={cell.title}>
      {cell.text}
    </span>
  );
}

/** The badge opens the task on its comments; it never sorts and never filters (P-22, P-36). */
function Comments(props: { readonly row: ProjectRow; readonly href: string }): ReactNode {
  const badge = commentBadge(props.row);
  if (badge === null) return null;
  return (
    <a
      className="cbd__cmt"
      href={`${props.href}#comments`}
      title={badge.title}
      aria-label={badge.title}
    >
      <span className="cbd__cmtg" aria-hidden="true">
        ◌
      </span>
      <span className="cbd__cmtn">{badge.count}</span>
    </a>
  );
}

function Assignee(props: { readonly row: ProjectRow }): ReactNode {
  const who = props.row.assignee;
  if (who === null) return dash();
  const short = who.name.split(/\s+/u)[0] ?? who.name;
  return (
    <div className="cbd__name" title={who.name}>
      <span className={who.agent ? 'cbd__av is-agent' : 'cbd__av'} aria-hidden="true">
        {who.agent ? 'A' : initials(who.name)}
      </span>
      <span className="cbd__nm">{who.agent ? 'AI' : short}</span>
    </div>
  );
}

function Estimate(props: { readonly row: ProjectRow }): ReactNode {
  const words = estimateWords(props.row.estimate);
  if (props.row.estimate === null) return dash();
  if (!words.tokens) return <span className="cbd__est">{words.text}</span>;
  return (
    <span className="cbd__tok" title={words.title}>
      {words.text}
      <span className="cbd__tokk">tokens</span>
    </span>
  );
}

function Actual(props: { readonly row: ProjectRow }): ReactNode {
  const burn = burnOf(props.row.estimate, props.row.actual);
  if (props.row.actual === null) return dash();
  if (burn.fill === null) {
    return (
      <span className="brn" title={burn.title}>
        <span className="brn__fig">{burn.figure}</span>
      </span>
    );
  }
  return (
    <span className={burn.over ? 'brn is-over' : 'brn'} title={burn.title}>
      <span className="brn__bar" aria-hidden="true">
        <span className="brn__fill" style={{ width: `${String(Math.round(burn.fill * 100))}%` }} />
      </span>
      {burn.figure === null ? null : <span className="brn__fig">{burn.figure}</span>}
    </span>
  );
}

function Due(props: { readonly row: ProjectRow; readonly now: Date }): ReactNode {
  const due = dueWords(props.row.due, props.row.completed, props.now);
  return due.tone === 'none' ? (
    dash()
  ) : (
    <span className="cbd__due" data-tone={due.tone}>
      {due.text}
    </span>
  );
}

const change = (what: string, row: ProjectRow): string => `Change the ${what} of ${row.name}`;

function assigneeEditor(row: ProjectRow, drawn: ReactNode, actions: RowActions): ReactNode {
  const { onAssign, people } = actions;
  if (onAssign === undefined || people === undefined) return drawn;
  const options = [
    ...people.map((person) => ({ value: person.id, label: person.name })),
    { value: '', label: UNASSIGNED },
  ];
  return (
    <EditableCell
      label={change('assignee', row)}
      editor={{ kind: 'menu', options, current: row.assignee?.id ?? '' }}
      onChoose={(value) => {
        onAssign(row, value === '' ? null : value);
      }}
    >
      {drawn}
    </EditableCell>
  );
}

function dueEditor(row: ProjectRow, drawn: ReactNode, actions: RowActions): ReactNode {
  const { onDue } = actions;
  if (onDue === undefined) return drawn;
  return (
    <EditableCell
      label={change('due date', row)}
      editor={{ kind: 'date', current: row.due?.slice(0, 10) ?? '' }}
      onChoose={(value) => {
        onDue(row, value === '' ? null : value);
      }}
    >
      {drawn}
    </EditableCell>
  );
}

function stageEditor(
  row: ProjectRow,
  drawn: ReactNode,
  actions: RowActions,
  stages: readonly string[],
): ReactNode {
  const { onStage } = actions;
  if (onStage === undefined || stages.length === 0) return drawn;
  return (
    <EditableCell
      label={change('stage', row)}
      editor={{
        kind: 'menu',
        options: stages.map((stage) => ({ value: stage, label: stage })),
        current: row.stage ?? '',
      }}
      onChoose={(value) => {
        onStage(row, value);
      }}
    >
      {drawn}
    </EditableCell>
  );
}

/** The cell as drawn, wrapped in its editor where the page hands in the command (MP-5-10). */
function editable(row: ProjectRow, key: string, drawn: ReactNode, context: CellContext): ReactNode {
  const actions = context.actions;
  if (actions === undefined) return drawn;
  if (key === 'assignee') return assigneeEditor(row, drawn, actions);
  if (key === 'due') return dueEditor(row, drawn, actions);
  if (key === 'stage') return stageEditor(row, drawn, actions, context.stages ?? []);
  return drawn;
}

/** What the Projects board draws in `key`'s cell of `row`. */
export function projectCell(row: ProjectRow, key: string, context: CellContext): ReactNode {
  switch (key) {
    case 'rank':
      return <Rank row={row} />;
    case 'name':
      return (
        <ProjectName
          row={row}
          href={context.href(row)}
          {...(context.actions === undefined ? {} : { actions: context.actions })}
        />
      );
    case 'comments':
      return <Comments row={row} href={context.href(row)} />;
    case 'client':
      return row.client ?? dash();
    case 'assignee':
      return editable(row, key, <Assignee row={row} />, context);
    case 'due':
      return editable(row, key, <Due row={row} now={context.now} />, context);
    case 'stage':
      return editable(
        row,
        key,
        row.stage === null ? dash() : <span className="cbd__chip">{row.stage}</span>,
        context,
      );
    case 'estimate':
      return <Estimate row={row} />;
    case 'actual':
      return <Actual row={row} />;
    default:
      return null;
  }
}
