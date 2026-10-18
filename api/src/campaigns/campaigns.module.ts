import { Module } from '@nestjs/common';
import { CampaignWorker } from './campaign-worker.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({ controllers: [CampaignsController], providers: [CampaignsService, CampaignWorker], exports: [CampaignWorker] })
export class CampaignsModule {}
