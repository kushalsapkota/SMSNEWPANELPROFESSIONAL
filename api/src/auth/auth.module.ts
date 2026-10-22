import { Global, Module } from '@nestjs/common';
import { AuthController, BrandingController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from './guards';
import { LoginRateLimiter } from './login-rate-limiter.service';
import { TokenService } from './token.service';

@Global()
@Module({
  controllers: [AuthController, BrandingController],
  providers: [AuthService, TokenService, JwtAuthGuard, RolesGuard, LoginRateLimiter],
  exports: [TokenService, AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
