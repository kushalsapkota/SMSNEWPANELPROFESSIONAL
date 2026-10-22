import { Module } from '@nestjs/common';
import { ApprovedContentController } from './approved-content.controller';
import { ApprovedContentService } from './approved-content.service';

@Module({ controllers: [ApprovedContentController], providers: [ApprovedContentService], exports: [ApprovedContentService] })
export class ApprovedContentModule {}
