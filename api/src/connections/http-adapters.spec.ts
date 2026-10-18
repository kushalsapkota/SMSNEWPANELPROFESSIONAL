import type { EngineAdapter } from '../engine/engine.types';
import { DLR_TOKEN_RE, generateDlrToken, isHttpUrlTemplate, mergeCredentials, mergeSettings } from './http-adapters';

const adapter = {
  id: 'x',
  name: 'X',
  country: 'NP',
  confidence: 'VERIFIED',
  credentials: [
    { key: 'token', label: 'Token', secret: true, required: true },
    { key: 'extra', label: 'Extra', secret: true, required: false },
  ],
  settings: [
    { key: 'url', label: 'URL', type: 'url', required: true, default: null },
    { key: 'n', label: 'N', type: 'number', required: false, default: 10 },
    { key: 'on', label: 'On', type: 'bool', required: false },
    { key: 'm', label: 'M', type: 'select', required: false, options: ['GET', { value: 'POST', label: 'Post' }] },
    { key: 'p', label: 'P', type: 'json', required: false },
  ],
  dlr_mode: 'none',
  supports_balance: false,
  destination_countries: null,
} as EngineAdapter;

describe('http adapter validation', () => {
  it('merges credentials: set, clear, unchanged; rejects unknown keys and missing required', () => {
    expect(mergeCredentials(adapter, { token: 'a' }, {})).toEqual({ merged: { token: 'a' }, issues: [] });
    expect(mergeCredentials(adapter, { extra: '' }, { token: 'a', extra: 'b' }).merged).toEqual({ token: 'a' });
    expect(mergeCredentials(adapter, undefined, { token: 'a', gone: 'z' }).merged).toEqual({ token: 'a' });
    const bad = mergeCredentials(adapter, { nope: 'x', token: '' }, { token: 'a' });
    expect(bad.issues.map((i) => i.path)).toEqual(['credentials.nope', 'credentials.token']);
  });

  it('validates setting types and merges (null resets)', () => {
    const ok = mergeSettings(adapter, { url: 'https://h.example/send?to={to}', n: 5, on: true, m: 'POST', p: { a: '{text}' } }, {});
    expect(ok.issues).toEqual([]);
    const bad = mergeSettings(adapter, { url: 'ftp://x', n: '5', on: 'yes', m: 'PUT', p: '{bad' }, {});
    expect(bad.issues.map((i) => i.path)).toEqual(['settings.url', 'settings.n', 'settings.on', 'settings.m', 'settings.p']);
    expect(mergeSettings(adapter, { n: null }, { url: 'https://a.b', n: 3 }).merged).toEqual({ url: 'https://a.b' });
  });

  it('url templates and dlr tokens', () => {
    expect(isHttpUrlTemplate('{base_url}/send')).toBe(false);
    expect(isHttpUrlTemplate('https://api.example.com/{token}/send')).toBe(true);
    expect(isHttpUrlTemplate('javascript:alert(1)')).toBe(false);
    const t = generateDlrToken();
    expect(t).toMatch(DLR_TOKEN_RE);
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(generateDlrToken()).not.toBe(t);
  });
});
