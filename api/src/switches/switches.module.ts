import { Module } from '@nestjs/common';
import { SwitchesController } from './switches.controller';
import { SwitchesService } from './switches.service';

@Module({ controllers: [SwitchesController], providers: [SwitchesService] })
export class SwitchesModule {}
