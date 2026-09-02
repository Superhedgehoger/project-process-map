import { type Asset, type IntlString, type Plugin, plugin } from '@hcengineering/platform'

export const projectProcessMapId = 'project-process-map' as Plugin

const projectProcessMap = plugin(projectProcessMapId, {
  string: {
    ProjectProcessMap: '' as IntlString
  },
  icon: {
    ProjectProcessMap: '' as Asset
  }
})

export default projectProcessMap
