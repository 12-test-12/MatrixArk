import { ForbiddenException } from '@nestjs/common';
import type { Role } from '@prisma/client';

/** 可分配的角色（owner 只能由创建者拥有，不通过接口授予） */
export const ASSIGNABLE_ROLES: readonly Role[] = ['editor', 'reviewer', 'operator', 'viewer'];

export type Action =
  | 'content:write'
  | 'content:approve'
  | 'task:schedule'
  | 'task:manage'
  | 'task:result'
  | 'account:manage'
  | 'member:manage'
  | 'workspace:settings'
  | 'worker:monitor';

const ALLOWED: Record<Action, readonly Role[]> = {
  'content:write': ['owner', 'editor'],
  'content:approve': ['owner', 'editor', 'reviewer'],
  'task:schedule': ['owner', 'editor'],
  'task:manage': ['owner', 'editor'],
  'task:result': ['owner', 'editor', 'operator'],
  'account:manage': ['owner', 'editor'],
  'member:manage': ['owner'],
  'workspace:settings': ['owner'],
  'worker:monitor': ['owner', 'operator'],
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: '负责人',
  editor: '编辑',
  reviewer: '审核',
  operator: '运营',
  viewer: '只读',
};

export function can(role: Role, action: Action): boolean {
  return ALLOWED[action].includes(role);
}

export function assertCan(role: Role, action: Action): void {
  if (!can(role, action)) {
    throw new ForbiddenException(`当前角色（${ROLE_LABELS[role]}）没有该操作权限`);
  }
}
