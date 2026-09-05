import TaskDetail from "../../components/task-detail";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="min-h-screen">
      <TaskDetail id={id} />
    </main>
  );
}
