import { type Builder } from '@hcengineering/model'
import core from '@hcengineering/model-core'
import workbench from '@hcengineering/model-workbench'
import { projectProcessMapId } from '@hcengineering/project-process-map'

import projectProcessMap from './plugin'

export { projectProcessMapId } from '@hcengineering/project-process-map'
export default projectProcessMap

export function createModel (builder: Builder): void {
  builder.createDoc(
    workbench.class.Application,
    core.space.Model,
    {
      label: projectProcessMap.string.ProjectProcessMap,
      icon: projectProcessMap.icon.ProjectProcessMap,
      alias: projectProcessMapId,
      hidden: false,
      component: projectProcessMap.component.ProjectProcessMapApplication,
      position: 'top',
      order: 350
    },
    projectProcessMap.app.ProjectProcessMap
  )
}
