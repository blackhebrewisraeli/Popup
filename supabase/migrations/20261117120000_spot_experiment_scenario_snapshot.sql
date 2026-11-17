-- An optional scenario snapshot on a Manual Spot experiment
-- (docs/MANUAL_SPOT_EXPERIMENTS.md#scenario-snapshot): the owner's hypothetical
-- Spot scenario, as the browser worked it out and showed it in the review the
-- owner confirmed. It is a planning record, not a rule, an order, a balance or
-- an execution.
--
-- Expand only: one nullable column, its shape check and its insert grant.
-- Existing experiments keep a null snapshot (no scenario recorded); nothing is
-- backfilled. An insert that leaves the column out, as earlier frontends do,
-- still works. Policies, the other grants and append-only access are unchanged.
--
-- The check covers the snapshot's version, structure, field types and size. It
-- does not establish who calculated it, and it neither re-runs nor verifies the
-- arithmetic: inputs and figures are client-submitted text, stored as sent.

alter table public.spot_experiments add column scenario_snapshot jsonb;

comment on column public.spot_experiments.scenario_snapshot is
  'Optional client-submitted scenario snapshot (format 1): the owner''s input strings and the figures shown at review. Shape-checked only; the arithmetic is not verified. Null: no scenario recorded.';

-- coalesce: a check that evaluates to null passes, so a missing piece must
-- read as false, never as unknown.
alter table public.spot_experiments
  add constraint spot_experiments_scenario_snapshot_shape check (
    scenario_snapshot is null or coalesce(
      jsonb_typeof(scenario_snapshot) = 'object'
      and octet_length(scenario_snapshot::text) <= 2048
      -- Format 1, and the scenario calculation that produced the figures. That
      -- is not the signal model's version.
      and scenario_snapshot ?& array['version', 'calculationVersion', 'inputs', 'figures']
      and scenario_snapshot - array['version', 'calculationVersion', 'inputs', 'figures'] = '{}'::jsonb
      and scenario_snapshot -> 'version' = '1'::jsonb
      and jsonb_typeof(scenario_snapshot -> 'calculationVersion') = 'string'
      and scenario_snapshot ->> 'calculationVersion' ~ '^spot-scenario-[1-9][0-9]{0,3}$'

      -- The owner's inputs: plain decimal strings as typed (never JSON numbers),
      -- amounts and prices above zero with at most 8 decimals. An unspecified
      -- fee is null, which is not the same as '0'.
      and jsonb_typeof(scenario_snapshot -> 'inputs') = 'object'
      and scenario_snapshot -> 'inputs' ?& array['allocation', 'maxLoss', 'entry', 'stop', 'feePercent']
      and (scenario_snapshot -> 'inputs')
        - array['allocation', 'maxLoss', 'entry', 'stop', 'feePercent'] = '{}'::jsonb
      and jsonb_typeof(scenario_snapshot #> '{inputs,allocation}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{inputs,maxLoss}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{inputs,entry}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{inputs,stop}') = 'string'
      and scenario_snapshot #>> '{inputs,allocation}' ~ '^[0-9]{0,32}(\.[0-9]{0,8})?$'
      and scenario_snapshot #>> '{inputs,maxLoss}' ~ '^[0-9]{0,32}(\.[0-9]{0,8})?$'
      and scenario_snapshot #>> '{inputs,entry}' ~ '^[0-9]{0,32}(\.[0-9]{0,8})?$'
      and scenario_snapshot #>> '{inputs,stop}' ~ '^[0-9]{0,32}(\.[0-9]{0,8})?$'
      and scenario_snapshot #>> '{inputs,allocation}' ~ '[1-9]'
      and scenario_snapshot #>> '{inputs,maxLoss}' ~ '[1-9]'
      and scenario_snapshot #>> '{inputs,entry}' ~ '[1-9]'
      and scenario_snapshot #>> '{inputs,stop}' ~ '[1-9]'
      and char_length(scenario_snapshot #>> '{inputs,allocation}') <= 32
      and char_length(scenario_snapshot #>> '{inputs,maxLoss}') <= 32
      and char_length(scenario_snapshot #>> '{inputs,entry}') <= 32
      and char_length(scenario_snapshot #>> '{inputs,stop}') <= 32
      and (
        jsonb_typeof(scenario_snapshot #> '{inputs,feePercent}') = 'null'
        or (
          jsonb_typeof(scenario_snapshot #> '{inputs,feePercent}') = 'string'
          and scenario_snapshot #>> '{inputs,feePercent}' ~ '^[0-9]{0,32}(\.[0-9]{0,4})?$'
          and scenario_snapshot #>> '{inputs,feePercent}' ~ '[0-9]'
          and char_length(scenario_snapshot #>> '{inputs,feePercent}') <= 32
        )
      )

      -- The figures as shown: display text (grouped digits, cents, '<0.01', a
      -- percent), never re-derived here.
      and jsonb_typeof(scenario_snapshot -> 'figures') = 'object'
      and scenario_snapshot -> 'figures' ?& array[
        'quantity', 'limitedBy', 'notional', 'unallocated', 'stopDistance',
        'stopDistancePercent', 'lossAtStop', 'fees'
      ]
      and (scenario_snapshot -> 'figures') - array[
        'quantity', 'limitedBy', 'notional', 'unallocated', 'stopDistance',
        'stopDistancePercent', 'lossAtStop', 'fees'
      ] = '{}'::jsonb
      and scenario_snapshot #>> '{figures,limitedBy}' in ('allocation', 'maxLoss', 'both')
      and jsonb_typeof(scenario_snapshot #> '{figures,limitedBy}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{figures,quantity}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{figures,notional}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{figures,unallocated}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{figures,stopDistance}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{figures,stopDistancePercent}') = 'string'
      and jsonb_typeof(scenario_snapshot #> '{figures,lossAtStop}') = 'string'
      and scenario_snapshot #>> '{figures,quantity}' ~ '^[0-9][0-9,]{0,39}(\.[0-9]{1,8})?$'
      and scenario_snapshot #>> '{figures,notional}' ~ '^<?[0-9][0-9,]{0,39}\.[0-9]{2}$'
      and scenario_snapshot #>> '{figures,unallocated}' ~ '^<?[0-9][0-9,]{0,39}\.[0-9]{2}$'
      and scenario_snapshot #>> '{figures,stopDistance}' ~ '^[0-9][0-9,]{0,39}(\.[0-9]{1,8})?$'
      and scenario_snapshot #>> '{figures,stopDistancePercent}' ~ '^[0-9]{1,3}\.[0-9]{2}%$'
      and scenario_snapshot #>> '{figures,lossAtStop}' ~ '^<?[0-9][0-9,]{0,39}\.[0-9]{2}$'
      and (
        jsonb_typeof(scenario_snapshot #> '{figures,fees}') = 'null'
        or (
          jsonb_typeof(scenario_snapshot #> '{figures,fees}') = 'object'
          and scenario_snapshot #> '{figures,fees}' ?& array['entry', 'exit', 'lossWithFees']
          and (scenario_snapshot #> '{figures,fees}') - array['entry', 'exit', 'lossWithFees'] = '{}'::jsonb
          and jsonb_typeof(scenario_snapshot #> '{figures,fees,entry}') = 'string'
          and jsonb_typeof(scenario_snapshot #> '{figures,fees,exit}') = 'string'
          and jsonb_typeof(scenario_snapshot #> '{figures,fees,lossWithFees}') = 'string'
          and scenario_snapshot #>> '{figures,fees,entry}' ~ '^<?[0-9][0-9,]{0,39}\.[0-9]{2}$'
          and scenario_snapshot #>> '{figures,fees,exit}' ~ '^<?[0-9][0-9,]{0,39}\.[0-9]{2}$'
          and scenario_snapshot #>> '{figures,fees,lossWithFees}' ~ '^<?[0-9][0-9,]{0,39}\.[0-9]{2}$'
        )
      )
      -- Fees appear in the figures exactly when a fee was assumed, '0' included.
      and (jsonb_typeof(scenario_snapshot #> '{inputs,feePercent}') = 'null')
        = (jsonb_typeof(scenario_snapshot #> '{figures,fees}') = 'null'),
      false
    )
  );

-- Clients name the content only, as before; this adds the one new content
-- column. The id, owner and recorded time still come from the database, and
-- no role gains update, delete or truncate.
grant insert (scenario_snapshot) on public.spot_experiments to authenticated;
