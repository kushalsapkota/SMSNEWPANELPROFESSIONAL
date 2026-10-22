import { Injectable, Logger } from '@nestjs/common';
import { currentAuth } from '../common/context';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';

/** The global service switches as returned to the panel. */
export interface ServiceSwitches {
  all_enabled: boolean;
  http_api_enabled: boolean;
  smpp_enabled: boolean;
  bulk_enabled: boolean;
  note: string | null;
  updated_at: Date;
  updated_by: string | null;
}

/** The subset a PUT may change (all optional — only provided keys are set). */
export interface ServiceSwitchesUpdate {
  all_enabled?: boolean;
  http_api_enabled?: boolean;
  smpp_enabled?: boolean;
  bulk_enabled?: boolean;
  note?: string | null;
}

/**
 * Admin-only global kill switches (db/migrations/009 service_switches). Flipping
 * one writes the single row and forces an engine config reload so the change is
 * enforced live (SMPP binds dropped, submits rejected) with no restart. Default
 * and fallback is all-on; the engine treats a missing row as all-on too.
 */
@Injectable()
export class SwitchesService {
  private readonly logger = new Logger(SwitchesService.name);

  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
  ) {}

  /** The current switches (reads the one row; admin-only via RLS). */
  async status(): Promise<ServiceSwitches> {
    return this.db.tenant(async (trx) => {
      const row = await trx.selectFrom('service_switches').selectAll().executeTakeFirst();
      // Fail open: if the row is somehow missing, report all-on (matches the engine).
      if (!row) {
        return {
          all_enabled: true,
          http_api_enabled: true,
          smpp_enabled: true,
          bulk_enabled: true,
          note: null,
          updated_at: new Date(),
          updated_by: null,
        };
      }
      return row as ServiceSwitches;
    });
  }

  /** Apply a change, record who/when, and reload the engine so it takes effect live. */
  async update(patch: ServiceSwitchesUpdate): Promise<ServiceSwitches> {
    const auth = currentAuth();
    const result = await this.db.tenant(async (trx) => {
      const row = await trx
        .updateTable('service_switches')
        .set({ ...patch, updated_at: new Date(), updated_by: auth.userId })
        .where('id', '=', true)
        .returningAll()
        .executeTakeFirstOrThrow();
      // Push the change to the engine after the row is committed.
      await this.db.afterCommit(async () => {
        await this.engine.reloadConfigQuietly();
      });
      return row as ServiceSwitches;
    });
    this.logger.log(
      `service switches updated by ${auth.userId}: all=${result.all_enabled} http=${result.http_api_enabled} smpp=${result.smpp_enabled} bulk=${result.bulk_enabled}`,
    );
    return result;
  }
}
