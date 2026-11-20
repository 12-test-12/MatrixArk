import { BadRequestException } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/**
 * 所有请求体统一过 zod。校验失败返回具体到字段的错误，
 * 界面能直接标红，不用猜是哪一项不合规。
 */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestException({
      message: '参数校验失败',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
