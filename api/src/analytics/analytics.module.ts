import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { EngineMetricsService } from './engine-metrics.service';

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService, EngineMetricsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
