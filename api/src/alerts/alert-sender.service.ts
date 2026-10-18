import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';

/**
 * Alert delivery channels. Email is active when SMTP_HOST is set (nodemailer SMTP transport);
 * Telegram when TELEGRAM_BOT_TOKEN is set (Bot API sendMessage). Both never throw.
 */
@Injectable()
export class AlertSender {
  private readonly logger = new Logger(AlertSender.name);
  /** Replaceable in tests. */
  transporter: Pick<Transporter, 'sendMail'> | null;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.transporter = config.SMTP_HOST
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE,
          ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } } : {}),
        })
      : null;
    this.from = config.SMTP_FROM ?? (config.SMTP_USER && config.SMTP_USER.includes('@') ? config.SMTP_USER : 'alerts@localhost');
  }

  get emailAvailable(): boolean {
    return this.transporter !== null;
  }

  get telegramAvailable(): boolean {
    return !!this.config.TELEGRAM_BOT_TOKEN;
  }

  async email(to: string[], subject: string, text: string): Promise<boolean> {
    if (!this.transporter || to.length === 0) return false;
    try {
      await this.transporter.sendMail({ from: this.from, to: to.join(', '), subject, text });
      return true;
    } catch (e) {
      this.logger.warn(`alert email to ${to.join(',')} failed: ${(e as Error).message}`);
      return false;
    }
  }

  async telegram(chatId: string, text: string): Promise<boolean> {
    const token = this.config.TELEGRAM_BOT_TOKEN;
    if (!token || !chatId) return false;
    try {
      const res = await fetch(`${this.config.TELEGRAM_API_URL}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!res.ok || body.ok === false) {
        this.logger.warn(`telegram alert to ${chatId} failed: HTTP ${res.status} ${body.description ?? ''}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`telegram alert to ${chatId} failed: ${(e as Error).message}`);
      return false;
    }
  }
}
