import { Module } from '@nestjs/common';
import { SmppAccountsController } from './smpp-accounts.controller';
import { SmppAccountsService } from './smpp-accounts.service';
@Module({ controllers: [SmppAccountsController], providers: [SmppAccountsService], exports: [SmppAccountsService] })
export class SmppAccountsModule {}
