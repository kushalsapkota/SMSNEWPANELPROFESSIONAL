import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AssignmentsService } from './assignments.service';
import { OrgRoutesController, RoutesController } from './routes.controller';
import { QuickRouteService } from './quick-route.service';
import { RoutesService } from './routes.service';

@Module({ imports: [ConnectionsModule], controllers: [RoutesController, OrgRoutesController], providers: [RoutesService, AssignmentsService, QuickRouteService], exports: [RoutesService, AssignmentsService] })
export class RoutesModule {}
