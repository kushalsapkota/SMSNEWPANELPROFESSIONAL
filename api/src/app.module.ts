import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AlertsModule } from './alerts/alerts.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, RolesGuard } from './auth/guards';
import { BalanceModule } from './balance/balance.module';
import { BlocklistModule } from './blocklist/blocklist.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { AppExceptionFilter } from './common/exception.filter';
import { TenantInterceptor } from './common/tenant.interceptor';
import { ConfigModule } from './config/config.module';
import { ConnectionsModule } from './connections/connections.module';
import { CryptoModule } from './crypto/crypto.service';
import { DashboardModule } from './dashboard/dashboard.controller';
import { DbModule } from './db/db.module';
import { EngineModule } from './engine/engine-client.service';
import { HealthModule } from './health/health.module';
import { IpWhitelistModule } from './ip-whitelist/ip-whitelist.module';
import { MessagesModule } from './messages/messages.module';
import { MessagingModule } from './messaging/messaging.module';
import { MonitorModule } from './monitor/monitor.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrgsModule } from './orgs/orgs.module';
import { PublicApiModule } from './public-api/public-api.module';
import { RedisModule } from './redis/redis.module';
import { RoutesModule } from './routes/routes.module';
import { SenderIdsModule } from './sender-ids/sender-ids.module';
import { SmppAccountsModule } from './smpp-accounts/smpp-accounts.module';
import { TemplatesModule } from './templates/templates.module';
import { TenancyModule } from './tenancy/scope.service';
import { TesterModule } from './tester/tester.controller';
import { WebhooksModule } from './webhooks/webhooks.module';

/** Feature modules (part 1: auth + management; part 2: /v1, messages, analytics, campaigns, tester, dashboard, alerts). */
export const FEATURE_MODULES = [
  AuthModule,
  HealthModule,
  OrgsModule,
  BalanceModule,
  ConnectionsModule,
  RoutesModule,
  TemplatesModule,
  SenderIdsModule,
  ApiKeysModule,
  SmppAccountsModule,
  IpWhitelistModule,
  WebhooksModule,
  BlocklistModule,
  NotificationsModule,
  AuditLogsModule,
  MonitorModule,
  // part 2
  PublicApiModule,
  MessagesModule,
  AnalyticsModule,
  TesterModule,
  CampaignsModule,
  DashboardModule,
  AlertsModule,
];

@Module({
  imports: [ConfigModule, DbModule, RedisModule, CryptoModule, EngineModule, AuditModule, TenancyModule, MessagingModule, ...FEATURE_MODULES],
  providers: [
    // Order matters: authentication first, then role checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
