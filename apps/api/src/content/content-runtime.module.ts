import { Module } from '@nestjs/common';
import { ContentService } from './content.service';
import { StorageService } from './storage.service';
import { TopicAiService } from './topic-ai.service';
import { TopicCollector } from './topic-collector.service';

@Module({
  providers: [ContentService, StorageService, TopicCollector, TopicAiService],
  exports: [ContentService, StorageService, TopicCollector, TopicAiService],
})
export class ContentRuntimeModule {}
