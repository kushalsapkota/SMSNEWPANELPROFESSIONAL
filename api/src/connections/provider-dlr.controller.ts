import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { NoRequestTransaction, Public } from '../common/decorators';
import { clientIp, proxyTrustOf } from '../common/request.util';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { ProviderDlrService } from './provider-dlr.service';

/**
 * Public provider delivery-report callback: `POST|GET /v1/provider-dlr/:dlr_token`.
 * Unauthenticated except the unguessable token. Forwards the request verbatim to the engine and
 * answers plain-text `OK` (200) — also for unknown tokens, which are not forwarded. 429 when rate
 * limited and 503 when the engine is unreachable, so the provider retries later.
 */
@ApiExcludeController()
@Public()
@NoRequestTransaction()
@Controller('v1/provider-dlr')
export class ProviderDlrController {
  constructor(
    private readonly dlr: ProviderDlrService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':token')
  post(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    return this.handle(token, req, res);
  }

  @Get(':token')
  get(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    return this.handle(token, req, res);
  }

  private async handle(token: string, req: Request, res: Response): Promise<void> {
    const out = await this.dlr.handle(token, req, clientIp(req, proxyTrustOf(this.config)));
    res.setHeader('Cache-Control', 'no-store');
    if (out.status === 200) res.status(200).type('text/plain').send('OK');
    else if (out.status === 429) res.status(429).setHeader('Retry-After', '1').type('text/plain').send('Too Many Requests');
    else res.status(503).setHeader('Retry-After', '30').type('text/plain').send('Service Unavailable');
  }
}
