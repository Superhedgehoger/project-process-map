import type { Resources } from '@hcengineering/platform'

import ProjectProcessMapApplication from './components/ProjectProcessMapApplication.svelte'

export default async (): Promise<Resources> => ({
  component: {
    ProjectProcessMapApplication
  }
})
