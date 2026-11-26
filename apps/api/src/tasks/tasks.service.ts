import { Injectable } from '@nestjs/common';
import { TaskCommandService } from './application/task-command.service';
import { TaskEvidenceService } from './application/task-evidence.service';
import { TaskMetricsService } from './application/task-metrics.service';
import { TaskQueryService } from './application/task-query.service';
import { TaskDispatchService } from './dispatch/task-dispatch.service';
import { TaskReceiptService } from './dispatch/task-receipt.service';

export type { WorkMetrics, WorkMetricsInput } from './domain/task-policy';

@Injectable()
export class TasksService {
  constructor(
    private readonly commands: TaskCommandService,
    private readonly queries: TaskQueryService,
    private readonly evidence: TaskEvidenceService,
    private readonly metrics: TaskMetricsService,
    private readonly dispatcher: TaskDispatchService,
    private readonly receipts: TaskReceiptService,
  ) { }

  schedule(...args: Parameters<TaskCommandService['schedule']>) {
    return this.commands.schedule(...args);
  }

  changeSchedule(...args: Parameters<TaskCommandService['changeSchedule']>) {
    return this.commands.changeSchedule(...args);
  }

  cancel(...args: Parameters<TaskCommandService['cancel']>) {
    return this.commands.cancel(...args);
  }

  verify(...args: Parameters<TaskCommandService['verify']>) {
    return this.commands.verify(...args);
  }

  list(...args: Parameters<TaskQueryService['list']>) {
    return this.queries.list(...args);
  }

  saveMetrics(...args: Parameters<TaskMetricsService['saveMetrics']>) {
    return this.metrics.saveMetrics(...args);
  }

  metricHistory(...args: Parameters<TaskMetricsService['metricHistory']>) {
    return this.metrics.metricHistory(...args);
  }

  syncMetrics(...args: Parameters<TaskMetricsService['syncMetrics']>) {
    return this.metrics.syncMetrics(...args);
  }

  syncDueArticleMetrics(...args: Parameters<TaskMetricsService['syncDueArticleMetrics']>) {
    return this.metrics.syncDueArticleMetrics(...args);
  }

  detail(...args: Parameters<TaskQueryService['detail']>) {
    return this.queries.detail(...args);
  }

  handoff(...args: Parameters<TaskEvidenceService['handoff']>) {
    return this.evidence.handoff(...args);
  }

  readEvidence(...args: Parameters<TaskEvidenceService['readEvidence']>) {
    return this.evidence.readEvidence(...args);
  }

  attachEvidence(...args: Parameters<TaskEvidenceService['attachEvidence']>) {
    return this.evidence.attachEvidence(...args);
  }

  recordResult(...args: Parameters<TaskCommandService['recordResult']>) {
    return this.commands.recordResult(...args);
  }

  dispatchDue(...args: Parameters<TaskDispatchService['dispatchDue']>) {
    return this.dispatcher.dispatchDue(...args);
  }

  pollAutomaticResults(...args: Parameters<TaskReceiptService['pollAutomaticResults']>) {
    return this.receipts.pollAutomaticResults(...args);
  }
}
