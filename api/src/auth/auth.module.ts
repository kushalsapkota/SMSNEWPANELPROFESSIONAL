import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from './guards';
import { TokenService } from './token.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtAuthGuard, RolesGuard],
  exports: [TokenService, AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
