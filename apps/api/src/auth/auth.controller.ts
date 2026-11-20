import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { loginSchema, registerSchema } from '@matrixark/shared';
import { config } from '../config';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CurrentUser, Public, type AuthedRequest } from './decorators';
import { hashPassword, verifyPassword } from './password';
import { SESSION_COOKIE, SessionService, type SessionUser } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(registerSchema, body);

    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new UnauthorizedException('该邮箱已注册');

    const passwordHash = await hashPassword(input.password);
    const user = await this.prisma.user.create({
      data: { email: input.email, name: input.name, passwordHash },
    });
    await this.workspaces.createForUser(user.id, input.workspaceName ?? `${input.name}的工作室`);

    return this.startSession({ id: user.id, email: user.email, name: user.name }, res);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user) throw new UnauthorizedException('邮箱或密码不对');
    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('邮箱或密码不对');

    return this.startSession({ id: user.id, email: user.email, name: user.name }, res);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionToken) await this.sessions.destroy(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: SessionUser) {
    const workspaces = await this.sessions.workspacesOf(user.id);
    return { user, workspaces };
  }

  private async startSession(user: SessionUser, res: Response) {
    const { token, expiresAt } = await this.sessions.create(user.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicBaseUrl.startsWith('https://'),
      path: '/',
      expires: expiresAt,
    });
    const workspaces = await this.sessions.workspacesOf(user.id);
    return { user, workspaces };
  }
}
