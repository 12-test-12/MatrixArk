import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { updateVariantSchema } from '@matrixark/shared';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { CurrentMembership, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { ContentService, variantSnapshot } from './content.service';

const confirmSchema = z.object({ note: z.string().trim().max(500).optional() });

@Controller('workspaces/:workspaceId/variants')
@UseGuards(WorkspaceGuard)
export class VariantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentService,
  ) {}

  @Get(':id')
  async detail(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    const variant = await this.prisma.variant.findFirst({
      where: { id, workspaceId },
      include: {
        ...variantSnapshot,
        tasks: {
          include: {
            account: { omit: { credentials: true, credentialsCiphertext: true, credentialsKeyId: true } },
            result: true,
          },
        },
      },
    });
    if (!variant) throw new NotFoundException('版本不存在');
    return variant;
  }

  @Get(':id/check')
  async check(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.content.check(workspaceId, id);
  }

  @Patch(':id')
  async revise(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'content:write');
    const input = parse(updateVariantSchema, body);
    const result = await this.content.reviseVariant({
      variantId: id,
      workspaceId,
      userId: user.id,
      input,
    });
    return result;
  }

  @Post(':id/confirm')
  async confirm(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    // 作者有审核权限时可以自己确认；没有权限的人一律不行
    assertCan(membership.role, 'content:approve');
    const input = parse(confirmSchema, body ?? {});
    const result = await this.content.confirm({
      variantId: id,
      workspaceId,
      userId: user.id,
      note: input.note,
    });
    return result;
  }
}
