import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, lastValueFrom } from 'rxjs';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { RequestStore, requestStore } from './context';
import { AuthedRequest, NO_REQUEST_TX } from './decorators';
import { clientIp, userAgent } from './request.util';

/**
 * Establishes the AsyncLocalStorage request context and, for authenticated requests,
 * runs the whole handler inside ONE tenant transaction (set_config app.org_id/app.role).
 * Handlers marked @NoRequestTransaction() open their own via db.tenant().
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const store: RequestStore = {
      auth: req.auth,
      meta: { ip: clientIp(req, this.config.TRUST_PROXY), userAgent: userAgent(req) },
    };
    const noTx = this.reflector.getAllAndOverride<boolean>(NO_REQUEST_TX, [ctx.getHandler(), ctx.getClass()]);
    const run = (): Promise<unknown> =>
      store.auth && !noTx ? this.db.tenant(() => lastValueFrom(next.handle(), { defaultValue: undefined })) : lastValueFrom(next.handle(), { defaultValue: undefined });
    return from(requestStore.run(store, run));
  }
}
