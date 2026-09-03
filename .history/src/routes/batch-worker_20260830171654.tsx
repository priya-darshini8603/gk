import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/batch-worker')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/batch-worker"!</div>
}
