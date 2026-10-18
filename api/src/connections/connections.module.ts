import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { AdapterCatalogue } from './http-adapters';
import { ProviderDlrController } from './provider-dlr.controller';
import { ProviderDlrService } from './provider-dlr.service';

@Module({
  controllers: [ConnectionsController, ProviderDlrController],
  providers: [ConnectionsService, AdapterCatalogue, ProviderDlrService],
  exports: [ConnectionsService, AdapterCatalogue],
})
export class ConnectionsModule {}
