import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { IS_PUBLIC_KEY, type AuthedRequest } from './decorators';
import { SESSION_COOKIE, SessionService } from './session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('未登录');

    const user = await this.sessions.resolve(token);
    if (!user) {
      context.switchToHttp().getResponse<Response>().clearCookie(SESSION_COOKIE, { path: '/' });
      throw new UnauthorizedException('会话已过期，请重新登录');
    }

    request.user = user;
    request.sessionToken = token;
    return true;
  }
}
