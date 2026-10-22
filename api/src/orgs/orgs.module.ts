import { Module } from '@nestjs/common';
import { BulkService } from './bulk.service';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({ controllers: [OrgsController], providers: [OrgsService, BulkService], exports: [OrgsService] })
export class OrgsModule {}
