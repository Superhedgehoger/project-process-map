import { type Asset, type IntlString, type Plugin, plugin } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'

export const projectProcessMapId = 'project-process-map' as Plugin

const projectProcessMap = plugin(projectProcessMapId, {
  string: {
    ProjectProcessMap: '' as IntlString
  },
  icon: {
    ProjectProcessMap: '' as Asset
  },
  component: {
    ProjectProcessMapApplication: '' as AnyComponent
  }
})

export default projectProcessMap
