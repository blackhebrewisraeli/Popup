// The only way the futures-execution function talks to Binance: a fixed table of routes on the
// USDⓈ-M Futures host (plus the one key-permission read on the Spot API host), HMAC-SHA256 signed.
// The caller can't choose a host, path or method. Live credentials are the function's own
// BINANCE_FUTURES_* secrets, separate from the read-only Spot connection's.
//
// Binance references (read 2026-11-27):
//   Base URL https://fapi.binance.com, signing, recvWindow, HTTP 503 variants:
//     https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
//   Error codes (-1006/-1007 execution status unknown, -2013, -4116):
//     https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code
//   Conditional orders on the Algo Service since 2025-12-09 (POST /fapi/v1/algoOrder):
//     https://developers.binance.com/docs/derivatives/change-log
//   Orders, algo orders, account and symbol configuration, position risk, commission, income:
//     https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api
//     https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api
//   Key permissions (GET /sapi/v1/account/apiRestrictions):
//     https://developers.binance.com/docs/wallet/account/api-key-permission

import { hmacSha256Hex } from '../binance-spot-account/handler.ts';

export const FUTURES_ORIGIN = 'https://fapi.binance.com';
export const SPOT_API_ORIGIN = 'https://api.binance.com';
/** Binance's default. Also the window after which an unanswered order can no longer be accepted. */
export const RECV_WINDOW_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;

/** Every Binance request this function can make: [method, path, signed, origin]. */
export const ROUTES = {
  apiRestrictions: ['GET', '/sapi/v1/account/apiRestrictions', true, SPOT_API_ORIGIN],
  exchangeInfo: ['GET', '/fapi/v1/exchangeInfo', false],
  bookTicker: ['GET', '/fapi/v1/ticker/bookTicker', false],
  premiumIndex: ['GET', '/fapi/v1/premiumIndex', false],
  accountConfig: ['GET', '/fapi/v1/accountConfig', true],
  symbolConfig: ['GET', '/fapi/v1/symbolConfig', true],
  balance: ['GET', '/fapi/v3/balance', true],
  commissionRate: ['GET', '/fapi/v1/commissionRate', true],
  income: ['GET', '/fapi/v1/income', true],
  positionRisk: ['GET', '/fapi/v3/positionRisk', true],
  openOrders: ['GET', '/fapi/v1/openOrders', true],
  openAlgoOrders: ['GET', '/fapi/v1/openAlgoOrders', true],
  setMarginType: ['POST', '/fapi/v1/marginType', true],
  setLeverage: ['POST', '/fapi/v1/leverage', true],
  newOrder: ['POST', '/fapi/v1/order', true],
  queryOrder: ['GET', '/fapi/v1/order', true],
  cancelOrder: ['DELETE', '/fapi/v1/order', true],
  newAlgoOrder: ['POST', '/fapi/v1/algoOrder', true],
  queryAlgoOrder: ['GET', '/fapi/v1/algoOrder', true],
  cancelAllOpenOrders: ['DELETE', '/fapi/v1/allOpenOrders', true],
  cancelAllAlgoOpenOrders: ['DELETE', '/fapi/v1/algoOpenOrders', true],
} as const;
export type Route = keyof typeof ROUTES;

/**
 * ok: Binance answered 2xx with JSON. rejected: Binance definitively did not act (4xx, or a 503
 * variant documented as a failure). unknown: the request may or may not have taken effect
 * (timeout, network, 408, the 503 "Unknown error" variant, -1006/-1007, other 5xx): reconcile
 * before acting on it, never retry blindly.
 */
export type Outcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'rejected'; status: number; code: number; msg: string }
  | { kind: 'unknown'; reason: string };

export interface FuturesClient {
  call(route: Route, params?: Record<string, string>): Promise<Outcome>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function futuresClient(deps: {
  fetch: typeof fetch;
  now: () => number;
  apiKey: string;
  apiSecret: string;
}): FuturesClient {
  return {
    async call(route, params = {}) {
      const [method, path, signed, origin = FUTURES_ORIGIN] = ROUTES[route] as readonly [
        string,
        string,
        boolean,
        string?,
      ];
      const query = new URLSearchParams(params);
      if (signed) {
        query.set('recvWindow', String(RECV_WINDOW_MS));
        query.set('timestamp', String(deps.now()));
        query.set('signature', await hmacSha256Hex(deps.apiSecret, query.toString()));
      }
      const text = query.toString();
      const url = text ? `${origin}${path}?${text}` : origin + path;
      let res: Response;
      let body: unknown;
      try {
        res = await deps.fetch(url, {
          method,
          headers: signed ? { 'X-MBX-APIKEY': deps.apiKey } : {},
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        body = await res.json().catch(() => undefined);
      } catch (error) {
        return { kind: 'unknown', reason: error instanceof Error ? error.name : 'network' };
      }
      return classify(res.status, body);
    },
  };
}

/** Binance's documented meaning of one answer (general info › HTTP return codes, error codes). */
export function classify(status: number, body: unknown): Outcome {
  // A 2xx without a readable body might still be an accepted order.
  if (status >= 200 && status < 300) {
    return body === undefined
      ? { kind: 'unknown', reason: 'unreadable 2xx' }
      : { kind: 'ok', body };
  }
  const code = isRecord(body) && typeof body['code'] === 'number' ? body['code'] : 0;
  const msg = isRecord(body) && typeof body['msg'] === 'string' ? body['msg'] : '';
  const unknown =
    status === 408 ||
    code === -1006 ||
    code === -1007 ||
    (status === 503 && /unknown error/i.test(msg)) ||
    (status >= 500 && status !== 503);
  if (unknown) return { kind: 'unknown', reason: `HTTP ${status} ${code}` };
  return { kind: 'rejected', status, code, msg: msg.slice(0, 200) };
}

/** Binance says this order or algo order does not exist (it may never have been accepted). */
export const isAbsent = (outcome: Outcome) =>
  outcome.kind === 'rejected' && (outcome.code === -2013 || /does not exist/i.test(outcome.msg));

/** A short, secret-free description of an outcome for logs, events and Telegram. */
export function describe(outcome: Outcome): string {
  if (outcome.kind === 'ok') return 'ok';
  if (outcome.kind === 'unknown') return `unknown (${outcome.reason})`;
  return [`rejected ${outcome.code || outcome.status}`, outcome.msg].filter(Boolean).join(' ');
}
