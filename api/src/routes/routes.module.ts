import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';
import { OrgRoutesController, RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';

@Module({ controllers: [RoutesController, OrgRoutesController], providers: [RoutesService, AssignmentsService], exports: [RoutesService, AssignmentsService] })
export class RoutesModule {}
