// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactElement } from 'react';
import { Icon, TabPanel, usePageToolbar } from '@launchastro/ui';
import { createPortal } from 'react-dom';
import { ProjectBoard, type ProjectsProps } from './projects/ProjectBoard.tsx';
import { WorkLog } from './projects/WorkLog.tsx';
import { ProjectsTabs } from './projects/ProjectsTabs.tsx';
import { TABS, useProjectsTab } from './projects/tab-address.ts';
import { useProjectBoardAddress } from './projects/board-address.ts';

export type { ProjectsProps };

export function Projects(props: ProjectsProps): ReactElement {
  const { canFileTask = false, inPanel } = props;
  const toolbar = usePageToolbar();
  const { tab, select, workLogOpened } = useProjectsTab(props.address, inPanel === true);
  // The board's place, held here so the toolbar's door carries the view the board is on.
  const place = useProjectBoardAddress(props.address, inPanel === true, tab !== 'board');
  // The page's New task goes in the page toolbar, else in its own row; the board's read draws it.
  const inline = inPanel === true || toolbar === null;
  const [row, setRow] = useState<HTMLElement | null>(null);
  return (
    <div className="stack projects">
      {tab === 'board' && inline ? <div className="projects__toolbar" ref={setRow} /> : null}
      <ViewSwitch tab={tab} select={select} toolbar={inPanel === true ? null : toolbar} />
      <TabPanel name="projects" tab="board" selected={tab}>
        <ProjectBoard
          canFileTask={canFileTask}
          hidden={tab !== 'board'}
          place={place}
          toolbar={tab === 'board' ? (inline ? row : toolbar) : null}
          client={props.client}
          grantKey={props.grantKey}
          {...(props.taskPanel === undefined ? {} : { taskPanel: props.taskPanel })}
          {...(props.address === undefined ? {} : { address: props.address })}
          inPanel={props.inPanel === true}
        />
      </TabPanel>
      <TabPanel name="projects" tab="worklog" selected={tab}>
        {workLogOpened ? (
          <WorkLog
            client={props.client}
            grantKey={props.grantKey}
            navigate={props.navigate}
            address={props.address}
            inPanel={inPanel === true}
          />
        ) : null}
      </TabPanel>
    </div>
  );
}

/** The view switch: a menu in the page toolbar when the page has one, else the page's own tabs. */
function ViewSwitch(props: {
  readonly tab: ReturnType<typeof useProjectsTab>['tab'];
  readonly select: ReturnType<typeof useProjectsTab>['select'];
  readonly toolbar: HTMLElement | null;
}): ReactElement {
  const { tab, select, toolbar } = props;
  return toolbar === null ? (
    <ProjectsTabs label="Tasks" name="projects" tabs={TABS} selected={tab} onSelect={select} />
  ) : (
    createPortal(<ProjectViews tab={tab} select={select} />, toolbar)
  );
}

function ProjectViews(props: {
  readonly tab: ReturnType<typeof useProjectsTab>['tab'];
  readonly select: ReturnType<typeof useProjectsTab>['select'];
}): ReactElement {
  const { tab, select } = props;
  return (
    <details className="projects__views">
      <summary aria-label="Task views" title="Task views">
        <Icon name="calendar" size="xs" />
      </summary>
      <ProjectsTabs label="Tasks" name="projects" tabs={TABS} selected={tab} onSelect={select} />
    </details>
  );
}
