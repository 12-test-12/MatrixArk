import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../auth/session.service';

export function topicChange(workspaceId: string, entityType: 'work' | 'source', entityId: string,
  action: string, actor?: SessionUser, details?: Prisma.InputJsonObject) {
  return { workspaceId, entityType, entityId, action, actorId: actor?.id, actorName: actor?.name, actorEmail: actor?.email, details };
}
