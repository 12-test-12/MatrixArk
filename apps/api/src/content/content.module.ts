import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { ContentRuntimeModule } from './content-runtime.module';
import { ManuscriptsController } from './manuscripts.controller';
import { TopicsController } from './topics.controller';
import { VariantsController } from './variants.controller';

@Module({
  imports: [ContentRuntimeModule],
  controllers: [ManuscriptsController, VariantsController, AssetsController, TopicsController],
  exports: [ContentRuntimeModule],
})
export class ContentModule {}
