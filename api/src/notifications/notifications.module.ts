import { Module } from '@nestjs/common';
import { NotificationsController, NotificationsService } from './notifications.controller';

@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
