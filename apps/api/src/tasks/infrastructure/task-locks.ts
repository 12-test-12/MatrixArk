import { Prisma } from '@prisma/client';

export const lockTables = {
  manuscript: Prisma.sql`"Manuscript"`,
  variant: Prisma.sql`"Variant"`,
  account: Prisma.sql`"ChannelAccount"`,
  task: Prisma.sql`"PublishTask"`,
};

export async function lockRows(tx: Prisma.TransactionClient, table: keyof typeof lockTables, workspaceId: string, ids: string[]) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${lockTables[table]}
    WHERE "workspaceId" = ${workspaceId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
  `;
  return rows.length === ids.length;
}

export function lockRow(tx: Prisma.TransactionClient, table: keyof typeof lockTables, workspaceId: string, id: string) {
  return lockRows(tx, table, workspaceId, [id]);
}

export async function databaseTime(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now;
}

export function hasLateAcceptance(db: Prisma.TransactionClient, id: string) {
  return db.taskEvent.findFirst({
    where: {
      taskId: id, kind: 'late_receipt', OR: [
        ...['submitted', 'under_review', 'published'].map((state) => ({ details: { path: ['state'], equals: state } })),
        { details: { path: ['remoteId'], not: Prisma.AnyNull } },
      ]
    },
    select: { id: true },
  });
}
