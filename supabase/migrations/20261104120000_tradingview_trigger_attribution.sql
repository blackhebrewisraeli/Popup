-- Additive trigger attribution for TradingView technical events. Existing rows
-- remain null and the UI labels them as not recorded; no historical reason is inferred.
alter table public.trading_signals
  add column if not exists trigger_schema_version text,
  add column if not exists trigger_reasons text[];

alter table public.trading_signals
  drop constraint if exists trading_signals_trigger_attribution_check;

alter table public.trading_signals
  add constraint trading_signals_trigger_attribution_check
  check (
    (trigger_schema_version is null and trigger_reasons is null)
    or (
      trigger_schema_version = '1'
      and trigger_reasons is not null
      and cardinality(trigger_reasons) between 1 and 4
      and trigger_reasons <@ array[
        'long_setup_transition',
        'low_score_risk_transition',
        'high_volatility_risk_transition',
        'atr_trailing_stop_breach',
        'high_conviction_transition'
      ]::text[]
    )
  );

create or replace function public.ingest_tradingview_signal(token_hash text, signal jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  owner uuid;
  existing public.trading_signals%rowtype;
  modern boolean;
  trigger_version text;
  reasons text[];
begin
  select t.user_id into owner
  from public.signal_webhook_tokens t
  where t.token_hash = $1;

  if owner is null then
    return 'unauthorized';
  end if;
  if signal is null then
    return 'authorized';
  end if;
  if signal ->> 'signal_kind' is null
     or signal ->> 'signal_kind' not in ('strategy', 'transport_test') then
    raise exception 'signal_kind must be strategy or transport_test' using errcode = 'check_violation';
  end if;

  trigger_version := signal ->> 'trigger_schema_version';
  if (trigger_version is null) <> ((signal -> 'trigger_reasons') is null) then
    raise exception 'trigger attribution must include version and reasons' using errcode = 'check_violation';
  end if;
  if trigger_version is not null then
    if trigger_version <> '1' or jsonb_typeof(signal -> 'trigger_reasons') <> 'array' then
      raise exception 'trigger attribution is unsupported' using errcode = 'check_violation';
    end if;
    select array_agg(value) into reasons
    from jsonb_array_elements_text(signal -> 'trigger_reasons') as reason(value);
    if cardinality(reasons) not between 1 and 4 then
      raise exception 'trigger_reasons must contain 1-4 reasons' using errcode = 'check_violation';
    end if;
    if cardinality(reasons) <>
       (select count(distinct value) from unnest(reasons) as item(value)) then
      raise exception 'trigger_reasons must not contain duplicates' using errcode = 'check_violation';
    end if;
  end if;

  modern := signal ->> 'exchange' is not null
    and signal ->> 'timeframe' is not null
    and signal ->> 'bar_time' is not null
    and signal ->> 'model_version' is not null;

  insert into public.trading_signals (
    user_id,
    signal_kind,
    ticker,
    action,
    signal_score,
    price,
    quantity,
    stop_loss,
    event_id,
    exchange,
    timeframe,
    bar_time,
    model_version,
    trigger_schema_version,
    trigger_reasons
  ) values (
    owner,
    signal ->> 'signal_kind',
    signal ->> 'ticker',
    signal ->> 'action',
    (signal ->> 'signal_score')::integer,
    (signal ->> 'price')::numeric,
    (signal ->> 'quantity')::numeric,
    (signal ->> 'stop_loss')::numeric,
    signal ->> 'event_id',
    signal ->> 'exchange',
    signal ->> 'timeframe',
    (signal ->> 'bar_time')::timestamptz,
    signal ->> 'model_version',
    trigger_version,
    reasons
  )
  on conflict do nothing
  returning * into existing;

  if existing.id is not null then
    return 'accepted';
  end if;

  if modern then
    select s.* into existing
    from public.trading_signals s
    where s.user_id = owner
      and s.signal_kind = signal ->> 'signal_kind'
      and upper(s.exchange) = upper(signal ->> 'exchange')
      and upper(s.ticker) = upper(signal ->> 'ticker')
      and (case when upper(s.timeframe) in ('D', '1D') then '1D' else upper(s.timeframe) end)
        = (case when upper(signal ->> 'timeframe') in ('D', '1D') then '1D' else upper(signal ->> 'timeframe') end)
      and s.model_version = signal ->> 'model_version'
      and s.action = signal ->> 'action'
      and s.bar_time = (signal ->> 'bar_time')::timestamptz;

    if existing.signal_score is distinct from (signal ->> 'signal_score')::integer
       or existing.price is distinct from (signal ->> 'price')::numeric
       or existing.quantity is distinct from (signal ->> 'quantity')::numeric
       or existing.stop_loss is distinct from (signal ->> 'stop_loss')::numeric
       or existing.trigger_schema_version is distinct from trigger_version
       or existing.trigger_reasons is distinct from reasons then
      return 'conflict';
    end if;
  end if;

  return 'duplicate';
end;
$$;

revoke all on function public.ingest_tradingview_signal(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_tradingview_signal(text, jsonb) to service_role;
