import { Module } from '@nestjs/common';
import { GeoIpService } from './geoip.service';
import { MonitorController } from './monitor.controller';

@Module({ controllers: [MonitorController], providers: [GeoIpService] })
export class MonitorModule {}
