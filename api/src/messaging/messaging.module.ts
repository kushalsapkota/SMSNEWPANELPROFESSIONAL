import { Global, Module } from '@nestjs/common';
import { SendService } from './send.service';

/** Shared send fan-out (public /v1 API, web quick send, campaigns). */
@Global()
@Module({ providers: [SendService], exports: [SendService] })
export class MessagingModule {}
