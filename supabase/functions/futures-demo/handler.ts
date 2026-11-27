// futures-demo Edge Function (docs/FUTURES_DEMO_EXECUTION.md). Two callers, both refused unless
// SB_REGION is eu-west-1 (where Binance answered this project's functions):
//
//   Telegram webhook  X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_WEBHOOK_SECRET. Only
//                     the configured owner in their private chat with the bot is served: Approve /
//                     Reject presses and the /synthetic command. Work runs after the 200 reply.
//   Scheduled tick    apikey must be a project secret key (as for the scheduled feeds): expire
//                     proposals, reconcile open executions, run the configured entry rule.
//
// Storage uses the project's secret key against tables no browser role can read or write. Secrets
// are never logged or returned. Binance requests go only to the Demo host (binance.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { demoClient } from './binance.ts';
import {
  decide,
  type EngineDeps,
  type ExecutionRow,
  FINAL_STATES,
  propose,
  type ProposalRow,
  type Store,
  syntheticCandidate,
  type Telegram,
  tick,
} from './engine.ts';
import { parseRiskLimits, RISK_ENV } from './plan.ts';

export const REGION = 'eu-west-1';
export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const TELEGRAM_TIMEOUT_MS = 8000;
const REQUIRED = [
  'SUPABASE_URL',
  'BINANCE_FUTURES_DEMO_API_KEY',
  'BINANCE_FUTURES_DEMO_API_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_USER_ID',
  'TELEGRAM_OWNER_CHAT_ID',
] as const;

export interface FuturesDemoDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomUUID: () => string;
  log: (line: string) => void;
  createClient: (url: string, key: string) => SupabaseClient;
  /** EdgeRuntime.waitUntil in production: lets Telegram get its 200 before the work runs. */
  background: (work: Promise<unknown>) => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function namedKeys(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.values(parsed).filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ID = /^-?\d{1,16}$/;

export function telegramApi(deps: Pick<FuturesDemoDeps, 'fetch' | 'log'>, token: string): Telegram {
  // The URL carries the token: never log it.
  const call = async (method: string, body: Record<string, unknown>): Promise<unknown> => {
    try {
      const res = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      const answer: unknown = await res.json().catch(() => null);
      if (isRecord(answer) && answer['ok'] === true) return answer['result'];
      deps.log(JSON.stringify({ fn: 'futures-demo', telegram: method, status: res.status }));
    } catch (error) {
      deps.log(
        JSON.stringify({
          fn: 'futures-demo',
          telegram: method,
          error: String((error as Error).name),
        }),
      );
    }
    return null;
  };
  return {
    async send(chatId, text, buttons) {
      const result = await call('sendMessage', {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(buttons
          ? {
              reply_markup: {
                inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))],
              },
            }
          : {}),
      });
      return isRecord(result) && typeof result['message_id'] === 'number'
        ? result['message_id']
        : null;
    },
    async edit(chatId, messageId, text) {
      // An empty keyboard removes the buttons, so a decided proposal can't be pressed again.
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: { inline_keyboard: [] },
      });
    },
    async answer(callbackQueryId, text) {
      await call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: text.slice(0, 200),
      });
    },
  };
}

const PROPOSALS = 'futures_demo_proposals';
const EXECUTIONS = 'futures_demo_executions';

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/** The Store over PostgREST. Database constraints and triggers enforce what the engine assumes. */
export function supabaseStore(client: SupabaseClient, log: (line: string) => void): Store {
  return {
    async pendingProposal() {
      const { data, error } = await client
        .from(PROPOSALS)
        .select('*')
        .eq('status', 'pending')
        .maybeSingle();
      fail(error);
      return data as ProposalRow | null;
    },
    async openExecutions() {
      const { data, error } = await client
        .from(EXECUTIONS)
        .select('*')
        .not('state', 'in', `(${FINAL_STATES.join(',')})`);
      fail(error);
      return (data ?? []) as ExecutionRow[];
    },
    async insertProposal(row) {
      const { error } = await client.from(PROPOSALS).insert(row);
      if (error?.code === '23505') return 'conflict';
      fail(error);
      return 'ok';
    },
    async setTelegramMessage(id, messageId) {
      const { error } = await client
        .from(PROPOSALS)
        .update({ telegram_message_id: messageId })
        .eq('id', id)
        .is('telegram_message_id', null);
      fail(error);
    },
    async getProposal(id) {
      const { data, error } = await client.from(PROPOSALS).select('*').eq('id', id).maybeSingle();
      fail(error);
      return data as ProposalRow | null;
    },
    async decide(id, status, by) {
      const { data, error } = await client
        .from(PROPOSALS)
        .update({ status, decided_by: by })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id');
      if (error?.message.includes('futures_demo_proposal_expired')) return 'expired';
      fail(error);
      return (data ?? []).length === 1 ? 'ok' : 'not_pending';
    },
    async expireDue(nowIso) {
      const { data, error } = await client
        .from(PROPOSALS)
        .update({ status: 'expired' })
        .eq('status', 'pending')
        .lte('expires_at', nowIso)
        .select('*');
      fail(error);
      return (data ?? []) as ProposalRow[];
    },
    async insertExecution(row) {
      const { error } = await client.from(EXECUTIONS).insert(row);
      if (error?.code === '23505') return 'blocked';
      fail(error);
      return 'ok';
    },
    async updateExecution(id, patch) {
      const { error } = await client.from(EXECUTIONS).update(patch).eq('proposal_id', id);
      fail(error);
    },
    async lease(id, nowIso, untilIso) {
      const { data, error } = await client
        .from(EXECUTIONS)
        .update({ lease_until: untilIso })
        .eq('proposal_id', id)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .select('proposal_id');
      fail(error);
      return (data ?? []).length === 1;
    },
    async event(proposalId, kind, detail) {
      const { error } = await client
        .from('futures_demo_events')
        .insert({ proposal_id: proposalId, kind, detail });
      // The audit trail must not stop a protective action: log and continue.
      if (error) log(JSON.stringify({ fn: 'futures-demo', event: kind, error: error.message }));
    },
  };
}

async function engineDeps(deps: FuturesDemoDeps): Promise<EngineDeps | { missing: string[] }> {
  const secretKey = namedKeys(deps.env('SUPABASE_SECRET_KEYS'))[0];
  const missing: string[] = REQUIRED.filter((name) => !deps.env(name));
  if (!secretKey) missing.push('SUPABASE_SECRET_KEYS');
  const owner = deps.env('TELEGRAM_OWNER_CHAT_ID') ?? '';
  if (missing.length === 0 && !ID.test(owner)) missing.push('TELEGRAM_OWNER_CHAT_ID (numeric)');
  if (missing.length > 0) return { missing };
  const env = (name: string) => deps.env(name) as string;
  return {
    store: supabaseStore(deps.createClient(env('SUPABASE_URL'), secretKey as string), deps.log),
    demo: demoClient({
      fetch: deps.fetch,
      now: deps.now,
      apiKey: env('BINANCE_FUTURES_DEMO_API_KEY'),
      apiSecret: env('BINANCE_FUTURES_DEMO_API_SECRET'),
    }),
    telegram: telegramApi(deps, env('TELEGRAM_BOT_TOKEN')),
    ownerChatId: Number(owner),
    risk: await parseRiskLimits(deps.env(RISK_ENV)),
    entriesEnabled: deps.env('FUTURES_DEMO_ENABLED') === 'true',
    now: deps.now,
    sleep: deps.sleep,
    randomUUID: deps.randomUUID,
    log: deps.log,
  };
}

/** The configured owner, in their private chat with the bot. */
function isOwner(deps: FuturesDemoDeps, fromId: unknown, chat: unknown): boolean {
  return (
    isRecord(chat) &&
    chat['type'] === 'private' &&
    String(fromId) === deps.env('TELEGRAM_OWNER_USER_ID') &&
    String(chat['id']) === deps.env('TELEGRAM_OWNER_CHAT_ID')
  );
}

function guarded(deps: FuturesDemoDeps, label: string, work: () => Promise<unknown>) {
  deps.background(
    work().catch((error: unknown) =>
      deps.log(
        JSON.stringify({ fn: 'futures-demo', work: label, error: (error as Error).message }),
      ),
    ),
  );
}

async function telegramUpdate(req: Request, deps: FuturesDemoDeps, engine: EngineDeps) {
  const update: unknown = await req.json().catch(() => null);
  const query = isRecord(update) ? update['callback_query'] : null;
  if (isRecord(query)) {
    const from = isRecord(query['from']) ? query['from'] : {};
    const message = isRecord(query['message']) ? query['message'] : {};
    const id = String(query['id']);
    if (!isOwner(deps, from['id'], message['chat'])) {
      deps.log(
        JSON.stringify({
          fn: 'futures-demo',
          refused: 'callback from a non-owner or non-private chat',
        }),
      );
      guarded(deps, 'answer', () => engine.telegram.answer(id, 'Not authorized.'));
      return json({ ok: true });
    }
    guarded(deps, 'decide', () =>
      decide(engine, {
        id,
        fromId: Number(from['id']),
        messageId: typeof message['message_id'] === 'number' ? message['message_id'] : null,
        data: query['data'],
      }),
    );
    return json({ ok: true });
  }
  const message = isRecord(update) && isRecord(update['message']) ? update['message'] : null;
  const text = typeof message?.['text'] === 'string' ? message['text'].trim() : '';
  const from = message && isRecord(message['from']) ? message['from'] : {};
  if (message && /^\/synthetic(\s|$)/.test(text) && isOwner(deps, from['id'], message['chat'])) {
    guarded(deps, 'synthetic', async () => {
      const requested = text.split(/\s+/)[1]?.toUpperCase();
      const allowed = 'limits' in engine.risk ? engine.risk.limits.symbols : [];
      const symbol = requested ?? allowed[0];
      const answer = symbol
        ? await propose(engine, syntheticCandidate(symbol))
        : `No proposal: ${'error' in engine.risk ? engine.risk.error : 'no symbol'}.`;
      if (!answer.startsWith('Proposed')) await engine.telegram.send(engine.ownerChatId, answer);
    });
  }
  // Everything else, from anyone, is ignored with a 200 so Telegram does not redeliver it.
  return json({ ok: true });
}

export async function handleFuturesDemo(req: Request, deps: FuturesDemoDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (deps.env('SB_REGION') !== REGION)
    return json({ error: 'Wrong region', expected: REGION }, 421);
  const telegramSecret = req.headers.get(SECRET_HEADER);
  if (telegramSecret !== null) {
    const expected = deps.env('TELEGRAM_WEBHOOK_SECRET');
    if (!expected || !constantTimeEqual(telegramSecret, expected))
      return json({ error: 'Unauthorized' }, 401);
  } else {
    const apikey = req.headers.get('apikey');
    if (!apikey || !namedKeys(deps.env('SUPABASE_SECRET_KEYS')).includes(apikey)) {
      return json({ error: 'Unauthorized' }, 401);
    }
  }
  const engine = await engineDeps(deps);
  if ('missing' in engine) return json({ error: 'Not configured', missing: engine.missing }, 503);
  if (telegramSecret !== null) return telegramUpdate(req, deps, engine);
  try {
    const summary = await tick(engine, deps.env('FUTURES_DEMO_RULE') || undefined);
    deps.log(JSON.stringify({ fn: 'futures-demo', tick: summary }));
    return json(summary);
  } catch (error) {
    // Rows keep their state; the next tick continues from it.
    deps.log(
      JSON.stringify({ fn: 'futures-demo', tick: 'stopped', error: (error as Error).message }),
    );
    return json({ error: 'Tick stopped', reason: (error as Error).message }, 500);
  }
}
