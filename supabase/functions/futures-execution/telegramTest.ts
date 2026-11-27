// Telegram smoke test for the futures-execution bot (docs/FUTURES_EXECUTION.md#telegram-smoke-test).
// A TEST message with Approve and Reject that exercises the owner binding, the one-time decision and
// expiry, and nothing else: it has its own table (futures_telegram_tests), never touches
// futures_proposals or futures_executions, and never builds a Binance client. It needs only the
// Telegram and storage secrets, so it works while FUTURES_LIVE_ENABLED and the Binance key are unset.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallbackQuery, Telegram } from './engine.ts';

export const TEST_TTL_MS = 10 * 60 * 1000;
const TESTS = 'futures_telegram_tests';
const TEST_DATA = /^t([ar]):([0-9a-f-]{36})$/;

export interface TelegramTestDeps {
  client: SupabaseClient;
  telegram: Telegram & { raw(method: string, body: Record<string, unknown>): Promise<unknown> };
  ownerChatId: number;
  now: () => number;
  randomUUID: () => string;
  log: (line: string) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isTestData = (data: unknown) => typeof data === 'string' && TEST_DATA.test(data);

const testButtons = (id: string) => [
  { text: '✅ Approve (TEST)', data: `ta:${id}` },
  { text: '✖ Reject (TEST)', data: `tr:${id}` },
];

function testText(id: string, expiresAt: string) {
  return [
    'TEST — Telegram smoke test for the Popup Futures bot',
    'This is not a trading proposal. Pressing a button contacts no exchange and places no order.',
    '',
    '1. Press ✅ Approve (TEST). Expect: "TEST approved — no order placed."',
    '2. Press either button again. Expect: "TEST already approved — nothing was done."',
    '',
    `Expires: ${expiresAt.slice(0, 16).replace('T', ' ')} UTC · test ${id.slice(0, 8)}`,
  ].join('\n');
}

async function audit(d: TelegramTestDeps, kind: string, id: string) {
  const { error } = await d.client
    .from('futures_events')
    .insert({ proposal_id: null, kind, detail: { test: id } });
  if (error) d.log(JSON.stringify({ fn: 'futures-execution', event: kind, error: error.message }));
}

/** Send one TEST message to the owner's chat; at most one is pending at a time. */
export async function sendTelegramTest(d: TelegramTestDeps): Promise<Record<string, unknown>> {
  const now = d.now();
  const expired = await d.client
    .from(TESTS)
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lte('expires_at', iso(now));
  if (expired.error) throw new Error(expired.error.message);
  const id = d.randomUUID();
  const expiresAt = iso(now + TEST_TTL_MS);
  const stored = await d.client
    .from(TESTS)
    .insert({ id, expires_at: expiresAt, telegram_chat_id: d.ownerChatId });
  if (stored.error?.code === '23505') {
    return { sent: false, reason: 'A TEST is already pending: press its buttons or let it expire' };
  }
  if (stored.error) throw new Error(stored.error.message);
  const messageId = await d.telegram.send(d.ownerChatId, testText(id, expiresAt), testButtons(id));
  if (messageId === null) {
    return {
      sent: false,
      reason:
        'Telegram refused the message: check TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID, and that the owner pressed Start',
    };
  }
  const bound = await d.client
    .from(TESTS)
    .update({ telegram_message_id: messageId })
    .eq('id', id)
    .is('telegram_message_id', null);
  if (bound.error) throw new Error(bound.error.message);
  await audit(d, 'telegram_test_sent', id);
  return { sent: true, test: id.slice(0, 8), expiresAt };
}

/** One press on a TEST button, already authenticated as the owner in their private chat. */
export async function decideTelegramTest(d: TelegramTestDeps, query: CallbackQuery): Promise<void> {
  const answer = (text: string) => d.telegram.answer(query.id, text);
  const match = typeof query.data === 'string' ? TEST_DATA.exec(query.data) : null;
  const id = match?.[2] ?? '';
  const found = await d.client.from(TESTS).select('*').eq('id', id).maybeSingle();
  const row = found.data as Record<string, unknown> | null;
  if (!match || !row || row['telegram_message_id'] !== query.messageId) {
    return answer('This button does not match the TEST. Nothing was done.');
  }
  const status = match[1] === 'a' ? 'approved' : 'rejected';
  const decided = await d.client
    .from(TESTS)
    .update({ status, decided_by: query.fromId })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (decided.error?.message.includes('futures_telegram_test_expired')) {
    return answer('TEST expired — nothing was done.');
  }
  if (decided.error) throw new Error(decided.error.message);
  if ((decided.data ?? []).length !== 1) {
    const current = await d.client.from(TESTS).select('status').eq('id', id).maybeSingle();
    const was = isRecord(current.data) ? String(current.data['status']) : 'handled';
    await audit(d, 'telegram_test_duplicate', id);
    return answer(`TEST already ${was} — nothing was done.`);
  }
  await audit(d, `telegram_test_${status}`, id);
  await answer(`TEST ${status} — no order placed.`);
  const at = iso(d.now()).slice(11, 19);
  // The buttons stay, so the owner can press again and see the duplicate refused.
  await d.telegram.edit(
    Number(row['telegram_chat_id']),
    query.messageId as number,
    `${testText(id, String(row['expires_at']))}\n\nTEST ${status.toUpperCase()} by the owner at ${at} UTC.`,
    testButtons(id),
  );
}

/**
 * Point the bot's webhook at this function in eu-west-1 with the stored secret, accepting button
 * presses only, and report what Telegram then shows. Returns no token or secret.
 */
export async function setupTelegram(
  d: TelegramTestDeps,
  supabaseUrl: string,
  webhookSecret: string,
): Promise<Record<string, unknown>> {
  const url = `${supabaseUrl}/functions/v1/futures-execution?forceFunctionRegion=eu-west-1`;
  const set = await d.telegram.raw('setWebhook', {
    url,
    secret_token: webhookSecret,
    allowed_updates: ['callback_query'],
    drop_pending_updates: true,
  });
  const [me, info] = await Promise.all([
    d.telegram.raw('getMe', {}),
    d.telegram.raw('getWebhookInfo', {}),
  ]);
  return {
    webhookSet: set === true,
    bot: isRecord(me) ? `@${String(me['username'])}` : null,
    webhookUrlMatches: isRecord(info) && info['url'] === url,
    pendingUpdates: isRecord(info) ? info['pending_update_count'] : null,
    lastError: isRecord(info) ? (info['last_error_message'] ?? null) : null,
  };
}
