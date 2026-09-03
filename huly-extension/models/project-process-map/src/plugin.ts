import { type Ref } from '@hcengineering/core'
import { type Application } from '@hcengineering/model-workbench'
import projectProcessMap, { projectProcessMapId } from '@hcengineering/project-process-map'
import { mergeIds } from '@hcengineering/platform'

type ProjectProcessMapModel = typeof projectProcessMap & {
  app: {
    ProjectProcessMap: Ref<Application>
  }
}

const projectProcessMapModel: ProjectProcessMapModel = mergeIds(projectProcessMapId, projectProcessMap, {
  app: {
    ProjectProcessMap: '' as Ref<Application>
  }
})

export default projectProcessMapModel
