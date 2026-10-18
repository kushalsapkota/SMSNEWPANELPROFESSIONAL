import { sumCounter } from '../../analytics/engine-metrics.service';
import { rate } from '../../analytics/analytics.service';
import { MAX_CAMPAIGN_RECIPIENTS, assertPlaceholders, normalizeColumn, parseRecipientsCsv, parseRecipientsJson, renderBody } from '../../campaigns/recipients';
import { AppError } from '../../common/errors';
import { decodeCursor, encodeCursor } from '../../messages/messages.service';
import { uuidV7 } from '../../../test/fake-engine';
import { csvField, csvRow } from '../csv';
import { resolveRange } from '../dates';
import { microsToDecimal } from '../money';
import { normalizeDestination, splitRecipients } from '../msisdn';
import { toRow } from '../send.service';
import { uuidV7Time, uuidV7Window } from '../uuidv7';

describe('msisdn', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['(0044) 7700-900.123', '00447700900123'],
    ['+44 7700–900123', '447700900123'],
    ['123456', '123456'],
  ])('%s → %s', (input, out) => expect(normalizeDestination(input)).toBe(out));
  it.each(['12345', '1234567890123456', '++4477009001', '44770090012a', ''])('rejects %p', (v) => expect(normalizeDestination(v)).toBeNull());
  it('splits recipient strings', () => {
    expect(splitRecipients('a, b;c\nd,,')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitRecipients([' x ', '', 'y'])).toEqual(['x', 'y']);
  });
});

describe('csv', () => {
  it('quotes only when needed and doubles quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('l1\r\nl2')).toBe('"l1\r\nl2"');
    expect(csvField(null)).toBe('');
    expect(csvField(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05.678Z');
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
  it('guards formula injection on free text', () => {
    expect(csvField('=1+1', true)).toBe("'=1+1");
    expect(csvField('-5% off, today', true)).toBe(`"'-5% off, today"`);
    expect(csvField('=1+1')).toBe('=1+1');
  });
});

describe('money', () => {
  it('formats micros without floating point', () => {
    expect(microsToDecimal(0)).toBe('0.000000');
    expect(microsToDecimal(5000)).toBe('0.005000');
    expect(microsToDecimal(1_234_567)).toBe('1.234567');
    expect(microsToDecimal(-1)).toBe('-0.000001');
    expect(microsToDecimal(9_007_199_254_740_991)).toBe('9007199254.740991');
    expect(microsToDecimal(null)).toBe('');
  });
});

describe('uuidv7 + cursor', () => {
  it('extracts the embedded time from v7 ids only', () => {
    const t = Date.UTC(2026, 9, 18, 8, 0, 0, 123);
    expect(uuidV7Time(uuidV7(t))?.getTime()).toBe(t);
    expect(uuidV7Time('3f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f')).toBeNull();
    const w = uuidV7Window(uuidV7(t), 1000)!;
    expect([w.from.getTime(), w.to.getTime()]).toEqual([t - 1000, t + 1000]);
  });
  it('round-trips cursors and rejects garbage', () => {
    const c = { createdAt: '2026-10-18 08:10:22.123456+00', id: '01890000-0000-7000-8000-000000000000' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ createdAt: '2026-10-18 13:40:22+05:30', id: c.id })).createdAt).toBe('2026-10-18 13:40:22+05:30');
    for (const bad of ['', 'xx', Buffer.from('["drop table", "x"]').toString('base64url'), Buffer.from(JSON.stringify(['2026-10-18 08:10:22+00', 'nope'])).toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(AppError);
    }
  });
});

describe('date ranges', () => {
  it('defaults to the last N days and treats a date-only `to` as inclusive', () => {
    const r = resolveRange(undefined, undefined, 7, 366);
    expect(r.to.getTime() - r.from.getTime()).toBe(7 * 86_400_000);
    const d = resolveRange('2026-10-01', '2026-10-01', 7, 366);
    expect(d.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(d.to.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(() => resolveRange('2026-10-02', '2026-10-01', 7, 366)).toThrow(AppError);
    expect(() => resolveRange('2024-01-01', '2026-01-01', 7, 366)).toThrow(/at most 366 days/);
  });
});

describe('send result mapping', () => {
  it('maps ok/error/missing batch entries', () => {
    expect(toRow('1', { message_id: 'm', status: 'ACCEPTED', parts: 2, encoding: 'GSM7', cost_micros: 7, route_id: 'r', sent_text: 's' })).toEqual({
      to: '1', message_id: 'm', status: 'ACCEPTED', parts: 2, cost_micros: 7,
    });
    expect(toRow('1', { error_code: 'ROUTE_NOT_FOUND', message: 'none' })).toEqual({ to: '1', error_code: 'ROUTE_NOT_FOUND', message: 'none' });
    expect(toRow('1', undefined)).toMatchObject({ error_code: 'INTERNAL' });
    expect(toRow('1', { error_code: 'WHATEVER', message: 'x' })).toMatchObject({ error_code: 'INTERNAL' });
  });
});

describe('campaign recipients', () => {
  it('normalises headers and renders placeholders', () => {
    expect(normalizeColumn('  First Name ')).toBe('first_name');
    expect(normalizeColumn('Order-#')).toBe('order');
    expect(renderBody('Hi {Name}, {missing} {name}', { name: 'Ann' })).toBe('Hi Ann, {missing} Ann');
    expect(() => assertPlaceholders('Hi {nam}', ['name'])).toThrow(/\{nam\}/);
    expect(() => assertPlaceholders('Hi {name} {}', ['name'])).not.toThrow();
  });
  it('accepts tab-delimited CSV and rejects malformed CSV', () => {
    expect(parseRecipientsCsv(Buffer.from('phone\tcity\n447700900001\tParis\n')).recipients).toEqual([{ destination: '447700900001', vars: { city: 'Paris' } }]);
    expect(() => parseRecipientsCsv(Buffer.from('phone,name\n"447700900001,unterminated\n'))).toThrow(/could not be parsed/);
    expect(() => parseRecipientsCsv(Buffer.from(''))).toThrow(/empty/);
    expect(() => parseRecipientsCsv(Buffer.from('phone,a,a\n447700900001,1,2\n'))).toThrow(/duplicate column/);
  });
  it(`caps campaigns at ${MAX_CAMPAIGN_RECIPIENTS} unique recipients`, () => {
    const rows = (n: number) => ['phone', ...Array.from({ length: n }, (_, i) => String(447000000000 + i))].join('\n');
    expect(parseRecipientsCsv(Buffer.from(rows(MAX_CAMPAIGN_RECIPIENTS))).recipients).toHaveLength(MAX_CAMPAIGN_RECIPIENTS);
    expect(() => parseRecipientsCsv(Buffer.from(rows(MAX_CAMPAIGN_RECIPIENTS + 1)))).toThrow(/at most 100000/);
    // duplicates do not count toward the cap
    const dup = ['phone', ...Array.from({ length: MAX_CAMPAIGN_RECIPIENTS }, (_, i) => String(447000000000 + i)), '447000000000'].join('\n');
    expect(parseRecipientsCsv(Buffer.from(dup)).duplicate_rows).toBe(1);
  });
  it('JSON recipients: numbers allowed, objects refused', () => {
    const r = parseRecipientsJson([{ phone: 447700900001, Amount: 12.5, note: null }]);
    expect(r.recipients).toEqual([{ destination: '447700900001', vars: { amount: '12.5' } }]);
    expect(r.columns).toEqual(['amount']);
    expect(() => parseRecipientsJson([{ phone: '447700900001', x: { y: 1 } } as never])).toThrow(/string or number/);
  });
});

describe('analytics helpers', () => {
  it('sums a Prometheus counter family only', () => {
    const text = '# TYPE smsgw_submit_total counter\nsmsgw_submit_total{a="1"} 10\nsmsgw_submit_total{a="2",b="x y"} 2.5\nsmsgw_submit_total_bucket 99\nsmsgw_submit_total 1\n';
    expect(sumCounter(text, 'smsgw_submit_total')).toBe(13.5);
    expect(sumCounter('other 1\n', 'smsgw_submit_total')).toBeNull();
  });
  it('delivery rate is a 4-decimal ratio', () => {
    expect(rate(2, 3)).toBe(0.6667);
    expect(rate(0, 0)).toBe(0);
  });
});
