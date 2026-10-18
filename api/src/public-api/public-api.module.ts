import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { ApiRateLimiter } from './rate-limiter.service';

@Module({ controllers: [PublicApiController], providers: [PublicApiService, ApiKeyGuard, ApiRateLimiter] })
export class PublicApiModule {}
