import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { ContentService } from './content.service';
import { ManuscriptsController } from './manuscripts.controller';
import { StorageService } from './storage.service';
import { TopicAiService } from './topic-ai.service';
import { TopicCollector } from './topic-collector.service';
import { TopicsController } from './topics.controller';
import { VariantsController } from './variants.controller';

@Module({
  controllers: [ManuscriptsController, VariantsController, AssetsController, TopicsController],
  providers: [ContentService, StorageService, TopicCollector, TopicAiService],
  exports: [ContentService, StorageService, TopicCollector],
})
export class ContentModule {}
