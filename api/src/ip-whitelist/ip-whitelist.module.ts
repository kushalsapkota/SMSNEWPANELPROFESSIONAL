import { Module } from '@nestjs/common';
import { IpWhitelistController } from './ip-whitelist.controller';
import { IpWhitelistService } from './ip-whitelist.service';
@Module({ controllers: [IpWhitelistController], providers: [IpWhitelistService], exports: [IpWhitelistService] })
export class IpWhitelistModule {}
