// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { TabPanel } from '@launchastro/ui';
import { ProjectBoard, type ProjectsProps } from './projects/ProjectBoard.tsx';
import { WorkLog } from './projects/WorkLog.tsx';
import { ProjectsTabs } from './projects/ProjectsTabs.tsx';
import { ProjectsToolbar } from './projects/ProjectsToolbar.tsx';
import { TABS, useProjectsTab } from './projects/tab-address.ts';

export type { ProjectsProps };

export function Projects(props: ProjectsProps): ReactElement {
  const { canFileTask = false, inPanel } = props;
  const { address, tab, select, workLogOpened } = useProjectsTab(props.address, inPanel === true);
  return (
    <div className="stack">
      {tab === 'board' ? (
        <ProjectsToolbar inPanel={inPanel === true} canFileTask={canFileTask} address={address} />
      ) : null}
      <ProjectsTabs label="Projects" name="projects" tabs={TABS} selected={tab} onSelect={select} />
      <TabPanel name="projects" tab="board" selected={tab}>
        <ProjectBoard
          canFileTask={canFileTask}
          hidden={tab !== 'board'}
          client={props.client}
          grantKey={props.grantKey}
          {...(props.taskPanel === undefined ? {} : { taskPanel: props.taskPanel })}
          {...(props.address === undefined ? {} : { address: props.address })}
          inPanel={props.inPanel === true}
        />
      </TabPanel>
      <TabPanel name="projects" tab="worklog" selected={tab}>
        {workLogOpened ? (
          <WorkLog client={props.client} grantKey={props.grantKey} navigate={props.navigate} />
        ) : null}
      </TabPanel>
    </div>
  );
}
