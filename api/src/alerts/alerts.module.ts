import { Module } from '@nestjs/common';
import { AlertSender } from './alert-sender.service';
import { AlertsWorker } from './alerts-worker.service';

/** Low-balance and route-down notifications (settings: /api/notifications/settings). */
@Module({ providers: [AlertSender, AlertsWorker], exports: [AlertsWorker, AlertSender] })
export class AlertsModule {}
