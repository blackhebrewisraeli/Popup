import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractGaps, DB_CONTRACT, type CatalogFunction } from '@/lib/dbContract';

const portfolioArgs = ['request_id', 'risk_profile', 'budget', 'holdings', 'dry_run', 'expected'];

// Production's functions on 2026-10-23, after 20261023090000.
const portfolio: CatalogFunction = {
  name: 'execute_paper_portfolio',
  args: portfolioArgs,
  defaults: 2,
  anon: false,
  authenticated: true,
};
// 20261114120000: revoked from public and anon, granted to authenticated.
const owner: CatalogFunction = {
  name: 'is_binance_spot_owner',
  args: [],
  defaults: 0,
  anon: false,
  authenticated: true,
};
const historicalPortfolioContract = {
  execute_paper_portfolio: {
    args: {
      request_id: 'always',
      risk_profile: 'always',
      budget: 'always',
      holdings: 'always',
      dry_run: 'always',
      expected: 'sometimes',
    },
    roles: ['authenticated'],
  },
} as const;

// The function as 20261022130000 left it: no `expected`.
const fiveArgPortfolio: CatalogFunction = {
  ...portfolio,
  args: portfolioArgs.slice(0, 5),
  defaults: 1,
};

const gapsWith = (functions: CatalogFunction[], missing_migrations: string[] = []) =>
  contractGaps({ missing_migrations, functions });
const historicalGaps = (...functions: CatalogFunction[]) =>
  contractGaps({ functions, missing_migrations: [] }, historicalPortfolioContract);

describe('contractGaps', () => {
  it('requires the Spot owner check and permits additional database functions', () => {
    expect(gapsWith([owner, portfolio])).toEqual([]);
  });

  it('blocks a release whose migrations are not all applied', () => {
    expect(gapsWith([owner], ['20261127120000'])).toEqual([
      'migration 20261127120000 is not applied',
    ]);
  });

  it('detects a required argument missing from the database signature', () => {
    expect(historicalGaps(fiveArgPortfolio)).toEqual([
      'execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run, expected): no function accepts these arguments (PGRST202), or none that anon or authenticated may execute',
    ]);
  });

  it('detects overloads that make a call ambiguous', () => {
    expect(historicalGaps(fiveArgPortfolio, portfolio)).toEqual([
      "execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run): 2 overloads accept it, so PostgREST can't choose one (PGRST203)",
    ]);
  });

  it('detects when a previously optional argument is made required', () => {
    expect(historicalGaps({ ...portfolio, defaults: 0 })).toEqual([
      'execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run): no function accepts these arguments (PGRST202), or none that anon or authenticated may execute',
    ]);
  });

  it('blocks a database without is_binance_spot_owner', () => {
    expect(gapsWith([], ['20261114120000'])).toEqual([
      'migration 20261114120000 is not applied',
      'is_binance_spot_owner(): no function accepts these arguments (PGRST202), or none that anon or authenticated may execute',
    ]);
  });

  it('blocks grants that differ from the roles the workspace uses', () => {
    expect(gapsWith([{ ...owner, anon: true, authenticated: false }])).toEqual([
      'is_binance_spot_owner(): anon can execute it; the frontend needs authenticated only',
      'is_binance_spot_owner(): authenticated cannot execute it; the frontend needs authenticated only',
    ]);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('DB_CONTRACT', () => {
  it('lists exactly the RPCs the frontend calls', () => {
    const called = new Set(
      sources(join(process.cwd(), 'src'))
        // Kept for replay and historical tests. Neither module is imported by the workspace.
        .filter(
          (file) =>
            !['db.ts', 'sharedPortfolio.ts'].some((name) =>
              file.endsWith(join('src', 'lib', name)),
            ),
        )
        .flatMap((file) =>
          [...readFileSync(file, 'utf8').matchAll(/\.rpc\(\s*'(\w+)'/g)].map((match) => match[1]),
        ),
    );
    expect([...called].sort()).toEqual(Object.keys(DB_CONTRACT).sort());
  });
});
