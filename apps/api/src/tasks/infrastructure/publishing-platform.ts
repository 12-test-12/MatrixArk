import type { AdapterResolverOptions, PublishInput } from '@matrixark/adapters';
import type { ChannelAccount, Platform, Prisma } from '@prisma/client';
import type { PublishableVariant } from '../domain/task-policy';

export const PUBLISHING_PLATFORMS = Symbol('PUBLISHING_PLATFORMS');

export interface PublishingPlatform {
  readonly platform: Platform;
  readonly errors: {
    unreadableCredentials: string;
    unavailableAuthorization: string;
    unavailableApplication: string;
    missingApplication: string;
    missingMetrics: string;
  };
  credentials(account: ChannelAccount): Record<string, string> | undefined;
  options(tx: Prisma.TransactionClient, account: ChannelAccount): Promise<AdapterResolverOptions | undefined>;
  applicationReady(tx: Prisma.TransactionClient, account: ChannelAccount): Promise<boolean>;
  dispatchScope(): Prisma.PublishTaskWhereInput[];
  receiptScope(): Prisma.PublishTaskWhereInput[];
  metricsScope(now: Date): Prisma.PublishTaskWhereInput;
  validateRemoteId(remoteId: string): void;
  prepareImages?(variant: PublishableVariant): Promise<NonNullable<PublishInput['variant']['images']>>;
}
