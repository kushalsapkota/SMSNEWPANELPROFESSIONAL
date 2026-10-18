import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import { EngineClient, EngineUnavailableError } from '../engine/engine-client.service';
import { SendService } from '../messaging/send.service';
import { uuidV7Window } from '../messaging/uuidv7';

export interface PublicSendInput {
  to: string | string[];
  from: string;
  text: string;
  client_ref?: string;
}

@Injectable()
export class PublicApiService {
  private readonly logger = new Logger(PublicApiService.name);

  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
    private readonly sender: SendService,
  ) {}

  send(input: PublicSendInput, idempotencyKey?: string) {
    return this.sender.send({
      orgId: currentAuth().orgId,
      channel: 'HTTP',
      to: input.to,
      from: input.from,
      text: input.text,
      clientRef: input.client_ref,
      idempotencyKey,
    });
  }

  /** CONTRACTS §11 message status; only the key's own org's messages (not a reseller's clients'). */
  async message(id: string) {
    const auth = currentAuth();
    const win = uuidV7Window(id);
    const row = await this.db.tenant((trx) => {
      let q = trx
        .selectFrom('message_logs')
        .select(['id', 'destination_addr', 'source_addr', 'status', 'dlr_stat', 'parts', 'client_cost_micros', 'refunded', 'created_at', 'submitted_at', 'dlr_received_at', 'client_msg_ref'])
        .where('id', '=', id)
        .where('org_id', '=', auth.orgId);
      if (win) q = q.where('created_at', '>=', win.from).where('created_at', '<', win.to);
      return q.executeTakeFirst();
    });
    if (!row) throw AppError.notFound('Message');
    return {
      message_id: row.id,
      to: row.destination_addr,
      from: row.source_addr,
      status: row.status,
      dlr_stat: row.dlr_stat,
      parts: row.parts,
      // A fully refunded message (failed before/at submission) cost nothing; partial refunds
      // are already reflected in client_cost_micros by the engine.
      cost_micros: row.refunded ? 0 : row.client_cost_micros,
      refunded: row.refunded,
      created_at: row.created_at,
      submitted_at: row.submitted_at,
      done_at: row.dlr_received_at,
      client_ref: row.client_msg_ref,
    };
  }

  /** Live balance from the engine (CONTRACTS §5); falls back to the synced snapshot if the engine is unreachable. */
  async balance() {
    const auth = currentAuth();
    const acct = await this.db.tenant((trx) =>
      trx.selectFrom('accounts_balance').select(['balance_micros', sql<string>`trim(currency)`.as('cur')]).where('org_id', '=', auth.orgId).executeTakeFirst(),
    );
    if (!acct) throw AppError.notFound('Balance');
    try {
      const live = await this.engine.getBalance(auth.orgId);
      return { balance_micros: live.balance_micros, currency: acct.cur };
    } catch (e) {
      if (!(e instanceof EngineUnavailableError)) throw e;
      this.logger.warn(`engine balance unavailable for ${auth.orgId}, using snapshot: ${e.message}`);
      return { balance_micros: acct.balance_micros, currency: acct.cur };
    }
  }
}
