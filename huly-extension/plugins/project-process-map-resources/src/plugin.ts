import projectProcessMap, { projectProcessMapId } from '@hcengineering/project-process-map'
import { mergeIds } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'

export default mergeIds(projectProcessMapId, projectProcessMap, {
  component: {
    ProjectProcessMapApplication: '' as AnyComponent
  }
})
