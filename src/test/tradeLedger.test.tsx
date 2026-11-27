import { describe, expect, it } from 'vitest';
import type { PortfolioTransaction } from '@/lib/portfolioAccounting';
import { executionDrag, frictionBps, realizedPnlOn, tradeLedgerCsv } from '@/lib/tradeLedger';

function trade(overrides: Partial<PortfolioTransaction>): PortfolioTransaction {
  return {
    id: 'tx',
    portfolioType: 'long_term_sim',
    type: 'buy',
    amount: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('trade ledger helpers', () => {
  const buy = trade({
    type: 'buy',
    ticker: 'AAPL',
    shares: 10,
    price: 100,
    fee: 2,
    slippage: 3,
    intent: 'rebalance',
  });
  const sell = trade({ type: 'sell', ticker: 'AAPL', shares: 4, price: 120, fee: 1 });
  const deposit = trade({ type: 'deposit', amount: 500, note: 'Top-up, "monthly"' });

  it('sums fees + slippage across fills only', () => {
    expect(executionDrag([buy, sell, deposit])).toBe(6);
    expect(executionDrag([])).toBe(0);
  });

  it("sums only the sells booked on the given local day as today's realized P&L", () => {
    const today = new Date(2026, 9, 18, 15, 0);
    const at = (hour: number, day = 18) => new Date(2026, 9, day, hour, 0).toISOString();
    const ledger = [
      trade({ type: 'sell', realizedPnl: 40, timestamp: at(0) }),
      trade({ type: 'sell', realizedPnl: -15, timestamp: at(23) }),
      trade({ type: 'sell', realizedPnl: 999, timestamp: at(23, 17) }), // yesterday
      trade({ type: 'buy', timestamp: at(10) }),
      trade({ type: 'sell', timestamp: at(11) }), // no realized P&L recorded
    ];
    expect(realizedPnlOn(ledger, today)).toBe(25);
    expect(realizedPnlOn([], today)).toBe(0);
  });

  it('expresses friction in bps of notional, null for cash movements', () => {
    expect(frictionBps(buy)).toBe(50);
    expect(frictionBps(sell)).toBeCloseTo(20.8333, 4);
    expect(frictionBps(deposit)).toBeNull();
  });

  it('exports RFC 4180 CSV with a header row and quoted user text', () => {
    const lines = tradeLedgerCsv([buy, sell, deposit]).split('\r\n');
    expect(lines[0]).toBe(
      'timestamp,side,ticker,quantity,price,fee,slippage,friction_bps,amount,realized_pnl,intent,note',
    );
    expect(lines[1]).toBe('2026-01-01T00:00:00.000Z,BUY,AAPL,10,100,2,3,50,0,,rebalance,');
    expect(lines[2]).toBe('2026-01-01T00:00:00.000Z,SELL,AAPL,4,120,1,,20.83,0,,,');
    expect(lines[3]).toBe('2026-01-01T00:00:00.000Z,DEPOSIT,,,,,,,500,,,"Top-up, ""monthly"""');
  });

  it('neutralises spreadsheet formulas in text but keeps negative numbers', () => {
    const csv = tradeLedgerCsv([
      trade({ type: 'sell', ticker: '=HYPERLINK("x")', shares: 1, price: 1, realizedPnl: -30 }),
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      `2026-01-01T00:00:00.000Z,SELL,"'=HYPERLINK(""x"")",1,1,,,0,0,-30,,`,
    );
  });
});
