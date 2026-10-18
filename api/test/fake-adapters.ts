import type { EngineAdapter } from '../src/engine/engine.types';

/**
 * Fake engine adapter catalogue (GET /internal/v1/adapters) shaped per
 * docs/providers/HTTP-CONNECTIONS-CONTRACT.md from docs/providers/nepal-adapters.json.
 */
const concurrency = { key: 'max_concurrency', label: 'Max concurrent requests', type: 'number', default: 10, options: null, required: false, help: null };

export const FAKE_ADAPTERS: EngineAdapter[] = [
  {
    id: 'sparrow_v2',
    name: 'Sparrow SMS (API v2)',
    country: 'NP',
    website: 'https://sparrowsms.com',
    docs_url: 'https://docs.sparrowsms.com/sms/outgoing_sendsms/',
    confidence: 'VERIFIED',
    credentials: [{ key: 'token', label: 'API Token', secret: true, required: true, placeholder: 'v2_...', help: null }],
    settings: [
      { key: 'sender', label: 'Sender identity (from)', type: 'string', default: null, options: null, required: true, help: 'Identity assigned to your account' },
      { key: 'base_url', label: 'API base URL', type: 'url', default: 'https://api.sparrowsms.com/v2', options: null, required: false, help: null },
      concurrency,
    ],
    dlr_mode: 'none',
    supports_balance: true,
    destination_countries: ['NP'],
    notes: 'Whitelist the gateway IPs in Sparrow. No delivery reports.',
  },
  {
    id: 'aakash_v3',
    name: 'Aakash SMS (v3)',
    country: 'NP',
    website: 'https://aakashsms.com',
    docs_url: 'https://aakashsms.com/documentation/',
    confidence: 'VERIFIED',
    credentials: [{ key: 'auth_token', label: 'Auth token', secret: true, required: true, placeholder: '64 hex characters', help: null }],
    settings: [
      { key: 'base_url', label: 'API base URL', type: 'url', default: 'https://sms.aakashsms.com', options: null, required: false, help: null },
      { key: 'dlr_poll_interval_s', label: 'Delivery report poll interval (s)', type: 'number', default: 60, options: null, required: false, help: null },
      concurrency,
    ],
    dlr_mode: 'poll',
    supports_balance: true,
    destination_countries: ['NP'],
    notes: 'Returns HTTP 200 on errors; check error === false.',
  },
  {
    id: 'messengernepal',
    name: 'MessengerNepal',
    country: 'NP',
    website: 'https://messengernepal.com.np',
    docs_url: 'https://messengernepal.com.np/docs',
    confidence: 'VERIFIED',
    credentials: [
      { key: 'token', label: 'API Key', secret: true, required: true, placeholder: 'msnp_live_...', help: null },
      { key: 'webhook_secret', label: 'Webhook signing secret', secret: true, required: false, placeholder: null, help: null },
    ],
    settings: [{ key: 'sender', label: 'Sender ID', type: 'string', default: null, options: null, required: false, help: null }, concurrency],
    dlr_mode: 'callback',
    supports_balance: false,
    destination_countries: ['NP'],
    notes: 'Configure the webhook URL in the MessengerNepal dashboard.',
  },
  {
    id: 'nestsms',
    name: 'Nest SMS',
    country: 'NP',
    website: 'https://nestsms.com',
    docs_url: 'https://nestsms.com/docs',
    confidence: 'LIKELY',
    credentials: [{ key: 'token', label: 'API Key', secret: true, required: true, placeholder: 'nsms_live_...', help: null }],
    settings: [
      { key: 'base_url', label: 'API base URL (ask Nest SMS)', type: 'url', default: null, options: null, required: true, help: null },
      { key: 'sender', label: 'Sender ID', type: 'string', default: null, options: null, required: false, help: null },
    ],
    dlr_mode: 'poll',
    supports_balance: true,
    destination_countries: ['NP'],
    notes: 'Production host not confirmed; ask the provider.',
  },
  {
    id: 'generic_http',
    name: 'Generic HTTP API',
    country: null,
    website: null,
    docs_url: null,
    confidence: 'VERIFIED',
    credentials: [
      { key: 'token', label: 'Token', secret: true, required: false, placeholder: null, help: 'Use {token} in templates' },
      { key: 'username', label: 'Username', secret: false, required: false, placeholder: null, help: null },
      { key: 'password', label: 'Password', secret: true, required: false, placeholder: null, help: null },
    ],
    settings: [
      { key: 'method', label: 'HTTP method', type: 'select', default: 'POST', options: ['GET', 'POST'], required: true, help: null },
      { key: 'url', label: 'URL template', type: 'url', default: null, options: null, required: true, help: null },
      {
        key: 'body_type',
        label: 'Body type',
        type: 'select',
        default: 'form',
        options: [
          { value: 'query', label: 'Query string' },
          { value: 'form', label: 'Form' },
          { value: 'json', label: 'JSON' },
        ],
        required: true,
        help: null,
      },
      { key: 'params_template', label: 'Parameters (JSON)', type: 'string', default: '{"to":"{to}","text":"{text}"}', options: null, required: true, help: null },
      { key: 'success_http_status', label: 'Success HTTP statuses', type: 'string', default: '200', options: null, required: false, help: null },
      { key: 'success_json_path', label: 'Success JSON path', type: 'string', default: null, options: null, required: false, help: null },
      { key: 'use_tls_verify', label: 'Verify TLS', type: 'bool', default: true, options: null, required: false, help: null },
      concurrency,
    ],
    dlr_mode: 'none',
    supports_balance: false,
    destination_countries: null,
    notes: 'Configurable adapter for unlisted providers.',
  },
] as EngineAdapter[];
