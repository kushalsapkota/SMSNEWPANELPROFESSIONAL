import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthContext } from '../common/context';
import { Auth, NoRequestTransaction, Public } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { email, password, uuid } from '../common/validation';
import { AuthService } from './auth.service';

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  totp_code: z.string().trim().min(6).max(32).optional(),
});
const refreshSchema = z.object({ refresh_token: z.string().min(16).max(256) });
const passwordSchema = z.object({ current_password: z.string().min(1).max(128), new_password: password });
const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });
const impersonateSchema = z.object({ org_id: uuid });

/** CONTRACTS §10 auth endpoints. Auth flows use the privileged pool, so no request transaction. */
@Controller('api/auth')
@NoRequestTransaction()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body.email, body.password, body.totp_code);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return this.auth.refresh(body.refresh_token);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    await this.auth.logout(body.refresh_token);
    return { ok: true };
  }

  @Get('me')
  me(@Auth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @Post('password')
  @HttpCode(200)
  password(@Auth() auth: AuthContext, @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>) {
    return this.auth.changePassword(auth, body.current_password, body.new_password);
  }

  @Post('totp/setup')
  @HttpCode(200)
  totpSetup(@Auth() auth: AuthContext) {
    return this.auth.totpSetup(auth);
  }

  @Post('totp/enable')
  @HttpCode(200)
  totpEnable(@Auth() auth: AuthContext, @Body(new ZodPipe(codeSchema)) body: z.infer<typeof codeSchema>) {
    return this.auth.totpEnable(auth, body.code);
  }

  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@Auth() auth: AuthContext, @Body(new ZodPipe(codeSchema)) body: z.infer<typeof codeSchema>) {
    await this.auth.totpDisable(auth, body.code);
    return { ok: true };
  }

  @Post('impersonate')
  @HttpCode(200)
  impersonate(@Auth() auth: AuthContext, @Body(new ZodPipe(impersonateSchema)) body: z.infer<typeof impersonateSchema>) {
    return this.auth.impersonate(auth, body.org_id);
  }

  @Post('impersonate/stop')
  @HttpCode(200)
  stop(@Auth() auth: AuthContext) {
    return this.auth.stopImpersonation(auth);
  }
}
