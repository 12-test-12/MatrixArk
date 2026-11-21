import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { type NotificationDelivery, type NotificationKind, type NotificationSetting, type Prisma } from '@prisma/client';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { decryptFeishu, encryptFeishu, sendFeishu, type DeliveryResult } from './feishu';

const minute = 60_000;
const overdueAfter = 4 * 60 * minute;
const deliveryWindow = 30 * minute;
const retries = [1, 5, 15];

function dedupeKey(kind: NotificationKind, handedOffAt: Date) {
  return `${kind === 'handoff_ready' ? 'handoff' : 'overdue'}:${handedOffAt.toISOString()}`;
}

function withinWindow(delivery: NotificationDelivery, now: Date) {
  return now.getTime() < delivery.scheduledAt.getTime() + deliveryWindow;
}

async function lockTask(tx: Prisma.TransactionClient, workspaceId: string, taskId: string) {
  await tx.$queryRaw`SELECT id FROM "PublishTask" WHERE id = ${taskId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
}

async function databaseTime(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now;
}

function presentSetting(setting: NotificationSetting | null) {
  return {
    enabled: setting?.enabled ?? false,
    webhookConfigured: Boolean(setting?.webhookCiphertext),
    signatureConfigured: Boolean(setting?.signSecretCiphertext),
    encryptionReady: Boolean(config.notificationKey),
  };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async setting(workspaceId: string) {
    return presentSetting(await this.prisma.notificationSetting.findUnique({ where: { workspaceId } }));
  }

  async updateSetting(workspaceId: string, userId: string, input: { enabled: boolean; webhook?: string; signSecret?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const where = { workspaceId };
      const previous = await tx.notificationSetting.findUnique({ where });
      if ((input.enabled || input.webhook || input.signSecret) && !config.notificationKey) {
        throw new ServiceUnavailableException('请先在 API 和 Worker 配置飞书凭据加密密钥');
      }
      const webhook = input.webhook ? encryptFeishu(workspaceId, 'webhook', input.webhook) : undefined;
      if (input.enabled && !webhook && !previous?.webhookCiphertext) throw new BadRequestException('请填写飞书机器人地址');
      const signSecret = input.signSecret ? encryptFeishu(workspaceId, 'signSecret', input.signSecret) : undefined;
      const credentials = {
        ...(webhook && { webhookCiphertext: webhook.ciphertext, webhookKeyId: webhook.keyId }),
        ...(input.signSecret !== undefined && {
          signSecretCiphertext: signSecret?.ciphertext ?? null, signSecretKeyId: signSecret?.keyId ?? null,
        }),
      };
      const data = { enabled: input.enabled, updatedById: userId, ...credentials };
      const saved = previous ? await tx.notificationSetting.update({ where, data })
        : await tx.notificationSetting.create({ data: { workspaceId, ...data } });
      return presentSetting(saved);
    });
  }

  async enqueueHandoff(tx: Prisma.TransactionClient, workspaceId: string, taskId: string, at: Date) {
    const kinds = ['handoff_ready', 'overdue_reminder'] as const;
    await tx.notificationDelivery.createMany({
      data: kinds.map((kind) => {
        const scheduledAt = kind === 'handoff_ready' ? at : new Date(at.getTime() + overdueAfter);
        return { workspaceId, taskId, kind, dedupeKey: dedupeKey(kind, at), scheduledAt, nextAttemptAt: scheduledAt };
      }),
      skipDuplicates: true,
    });
  }

  async deliverDue(signal?: AbortSignal) {
    const now = await databaseTime(this.prisma);
    const due = await this.prisma.notificationDelivery.findMany({
      where: { OR: [
        { status: 'pending', nextAttemptAt: { lte: now } },
        { status: 'sending', leaseExpiresAt: { lte: now } },
      ] },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 30,
      select: { id: true, workspaceId: true, taskId: true },
    });
    for (const candidate of due) {
      if (signal?.aborted) return;
      const claimed = await this.claim(candidate);
      if (!claimed) continue;
      const { delivery, setting, text } = claimed;
      const current = await this.prisma.notificationDelivery.findUnique({
        where: { id: delivery.id },
        include: { task: { select: { status: true, handedOffAt: true, executionChannel: true } },
          workspace: { select: { notificationSetting: true } } },
      });
      const clock = await databaseTime(this.prisma);
      if (!current || current.status !== 'sending' || current.leaseId !== delivery.leaseId
        || !current.leaseExpiresAt || current.leaseExpiresAt <= clock) continue;
      const configured = current.workspace.notificationSetting;
      const eligible = this.isStillWaiting(delivery, current.task) && withinWindow(delivery, clock)
        && configured?.enabled && configured.updatedAt.getTime() === setting.updatedAt.getTime();
      if (!eligible) {
        await this.finish(delivery, { status: 'skipped', reason: '任务、投递窗口或飞书配置已变更' });
        continue;
      }
      const result = await this.send(setting, text);
      await this.finish(delivery, result);
      // A single Worker stays under Feishu's per-minute limit while draining a batch.
      await delay(650, undefined, { signal }).catch((error: unknown) => {
        if (!signal?.aborted) throw error;
      });
    }
  }

  private isStillWaiting(delivery: NotificationDelivery,
    task: { status: string; handedOffAt: Date | null; executionChannel: string | null }) {
    return task.status === 'handed_off' && task.executionChannel === 'manual'
      && task.handedOffAt && delivery.dedupeKey === dedupeKey(delivery.kind, task.handedOffAt);
  }

  private async claim(candidate: Pick<NotificationDelivery, 'id' | 'workspaceId' | 'taskId'>) {
    return this.prisma.$transaction(async (tx) => {
      await lockTask(tx, candidate.workspaceId, candidate.taskId);
      const delivery = await tx.notificationDelivery.findUnique({
        where: { id: candidate.id },
        include: { task: { include: {
          variant: { select: { title: true, platform: true } }, account: { select: { displayName: true } },
        } }, workspace: { select: { notificationSetting: true, name: true } } },
      });
      if (!delivery) return;
      const now = await databaseTime(tx);
      if (delivery.status === 'sending' && delivery.leaseExpiresAt && delivery.leaseExpiresAt <= now) {
        await this.record(tx, delivery, { status: 'failed', reason: '飞书投递结果未知' }, now);
        return;
      }
      if (delivery.status !== 'pending' || !delivery.nextAttemptAt || delivery.nextAttemptAt > now) return;
      const setting = delivery.workspace.notificationSetting;
      if (!withinWindow(delivery, now) || !this.isStillWaiting(delivery, delivery.task) || !setting?.enabled) {
        const reason = !withinWindow(delivery, now) ? '提醒已过期'
          : !this.isStillWaiting(delivery, delivery.task) ? '任务已处理或交接轮次已变更' : '工作室飞书提醒已关闭';
        await this.record(tx, delivery, { status: 'skipped', reason }, now);
        return;
      }
      const claimed = await tx.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'sending', attempts: { increment: 1 }, nextAttemptAt: null,
          leaseId: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 20_000) },
      });
      const { variant, account } = delivery.task;
      const headline = delivery.kind === 'handoff_ready' ? '发布任务待交接处理' : '发布任务交接后 4 小时仍未回填';
      const platform = variant.platform === 'xiaohongshu' ? '小红书' : 'B 站专栏';
      const text = [`MatrixArk · ${headline}`, `${delivery.workspace.name} · ${platform} · ${account.displayName}`,
        variant.title, '请在工作台打开「发布任务 → 待回填」查看并处理。',
        ...(config.publicBaseUrl ? [config.publicBaseUrl] : [])].join('\n').replaceAll('<', '＜').replaceAll('>', '＞');
      return { delivery: claimed, setting, text };
    });
  }

  private async send(setting: NotificationSetting, text: string): Promise<DeliveryResult> {
    try {
      const { workspaceId, webhookCiphertext, webhookKeyId, signSecretCiphertext, signSecretKeyId } = setting;
      if (!webhookCiphertext) return { status: 'failed', reason: '飞书机器人地址未配置' };
      const webhook = decryptFeishu(workspaceId, 'webhook', webhookCiphertext, webhookKeyId);
      const secret = signSecretCiphertext ? decryptFeishu(workspaceId, 'signSecret', signSecretCiphertext, signSecretKeyId) : undefined;
      return sendFeishu(webhook, secret, text);
    } catch {
      return { status: 'failed', reason: '无法读取飞书配置，请重新保存机器人设置' };
    }
  }

  private async finish(delivery: NotificationDelivery, outcome: DeliveryResult) {
    await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, delivery.workspaceId, delivery.taskId);
      const current = await tx.notificationDelivery.findUnique({ where: { id: delivery.id } });
      const now = await databaseTime(tx);
      if (current?.status !== 'sending' || current.leaseId !== delivery.leaseId
        || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return;
      await this.record(tx, current, outcome, now);
    });
  }

  private async record(tx: Prisma.TransactionClient, delivery: NotificationDelivery, outcome: DeliveryResult, now: Date) {
    const wait = retries[delivery.attempts - 1];
    const retryAt = outcome.status === 'retry' && wait !== undefined ? new Date(now.getTime() + wait * minute) : null;
    const nextAttemptAt = retryAt && withinWindow(delivery, retryAt) ? retryAt : null;
    const status = outcome.status === 'retry' ? nextAttemptAt ? 'pending' : 'failed' : outcome.status;
    const reason = outcome.status === 'sent' ? null : outcome.reason;
    await tx.notificationDelivery.update({
      where: { id: delivery.id }, data: {
        status, nextAttemptAt, leaseId: null, leaseExpiresAt: null, lastError: reason, sentAt: status === 'sent' ? now : null,
      },
    });
    if (status !== 'pending') {
      const eventReason = status === 'sent'
        ? (delivery.kind === 'handoff_ready' ? '交接提醒已送达' : '4 小时未回填提醒已送达')
        : reason;
      await tx.taskEvent.create({
        data: { workspaceId: delivery.workspaceId, taskId: delivery.taskId, kind: 'reminder', reason: eventReason,
          details: { deliveryId: delivery.id, kind: delivery.kind, status } },
      });
    }
  }
}
