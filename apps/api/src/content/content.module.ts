import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { ContentService } from './content.service';
import { ManuscriptsController } from './manuscripts.controller';
import { StorageService } from './storage.service';
import { VariantsController } from './variants.controller';

@Module({
  controllers: [ManuscriptsController, VariantsController, AssetsController],
  providers: [ContentService, StorageService],
  exports: [ContentService, StorageService],
})
export class ContentModule {}
