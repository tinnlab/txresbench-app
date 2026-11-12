import { useEffect } from 'react'
import { Drawer } from '@txresbench/shell'
import { JobsDrawer as JobsDrawerStore } from '@/modules/jobs/JobsDrawer.store'
import { Jobs } from '@/modules/jobs/Jobs.store'
import { JobList } from './JobList'
import { JobDetail } from './JobDetail'

/**
 * The Jobs drawer host — mounted once (via the `appBanners` slot) so the sidebar
 * button can open it from anywhere. Renders nothing until opened. On open it fetches
 * the job list once; it then stays live off the `sync:job` stream (wired in
 * `Jobs.store` init — notify-and-refetch, no poll) and shows either the LIST or, when a
 * job is selected, its DETAIL.
 */
export function JobsDrawer() {
  const { isOpen } = JobsDrawerStore
  const { selectedId } = Jobs

  useEffect(() => {
    if (isOpen) {
      void Jobs.load()
    } else {
      Jobs.closeDetail()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  return (
    <Drawer
      open={isOpen}
      onClose={() => JobsDrawerStore.close()}
      title={selectedId ? 'Job' : 'Jobs'}
      size={480}
      data-testid="jobs-drawer"
    >
      {selectedId ? <JobDetail /> : <JobList />}
    </Drawer>
  )
}
