import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Membership, Role } from '@prisma/client';
import type { SessionUser } from './session.service';

export const IS_PUBLIC_KEY = 'matrixark:isPublic';

/** 不需要登录的路由（注册、登录、健康检查） */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthedRequest extends Request {
  user?: SessionUser;
  sessionToken?: string;
  membership?: Membership;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!request.user) throw new Error('CurrentUser 只能在已登录路由使用');
  return request.user;
});

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Membership => {
    const request = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!request.membership) throw new Error('CurrentMembership 只能在 WorkspaceGuard 之后使用');
    return request.membership;
  },
);

export const CurrentRole = createParamDecorator((_data: unknown, ctx: ExecutionContext): Role => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!request.membership) throw new Error('CurrentRole 只能在 WorkspaceGuard 之后使用');
  return request.membership.role;
});
