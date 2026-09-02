import { loadMetadata } from '@hcengineering/platform'
import projectProcessMap from '@hcengineering/project-process-map'

const icons = require('../assets/icons.svg') as string // eslint-disable-line
loadMetadata(projectProcessMap.icon, {
  ProjectProcessMap: `${icons}#project-process-map`
})
