import { assertTransition } from '@matrixark/shared';
import type { Prisma, PublishTask, TaskStatus } from '@prisma/client';

type TaskIdentity = Pick<PublishTask, 'id' | 'workspaceId' | 'status'>;
type TransitionData = Omit<Prisma.PublishTaskUncheckedUpdateInput, 'id' | 'workspaceId' | 'status'> & {
  status: TaskStatus;
};
type TransitionEvent = Omit<Prisma.TaskEventCreateManyInput, 'workspaceId' | 'taskId' | 'fromStatus' | 'toStatus'>;

// 调用方先锁定任务，并传入当前事务。租约、取消字段与状态在同一次更新中保存。
export async function transitionTask(
  tx: Prisma.TransactionClient,
  task: TaskIdentity,
  data: TransitionData,
  event: TransitionEvent,
) {
  const rescheduling = task.status === 'scheduled' && data.status === 'scheduled' && event.kind === 'rescheduled';
  if (!rescheduling) assertTransition(task.status, data.status);
  const updated = await tx.publishTask.update({
    where: { id: task.id, workspaceId: task.workspaceId, status: task.status },
    data,
  });
  await tx.taskEvent.create({
    data: { ...event, workspaceId: task.workspaceId, taskId: task.id, fromStatus: task.status, toStatus: data.status },
  });
  return updated;
}

export async function pauseScheduledTasks(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  target: Prisma.PublishTaskWhereInput,
  reason: string,
  actorId: string,
) {
  assertTransition('scheduled', 'paused');
  const paused = await tx.publishTask.updateManyAndReturn({
    where: { ...target, workspaceId, status: 'scheduled' },
    data: { status: 'paused', lastError: reason },
    select: { id: true },
  });
  if (paused.length) await tx.taskEvent.createMany({
    data: paused.map(({ id: taskId }) => ({
      workspaceId, taskId, kind: 'paused', fromStatus: 'scheduled', toStatus: 'paused', actorId, reason,
    })),
  });
  return paused.length;
}
