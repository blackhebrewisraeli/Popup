import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { stableSerialize } from './evaluationStore';
import {
  CRYPTO_RESEARCH_SPECIFICATION,
  CRYPTO_RESEARCH_SPECIFICATION_ID,
} from './scannerResearchCrypto';
import { CRYPTO_TRADINGVIEW_SYMBOLS } from './tradingViewImport';

describe('crypto scanner study specification', () => {
  it('keeps the frozen machine-readable specification aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/scanner-research-crypto.v1.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(CRYPTO_RESEARCH_SPECIFICATION));
    expect(CRYPTO_RESEARCH_SPECIFICATION_ID).toBe(
      '6d005fee9ffdfb561e3ea8412800d0d5f116fc816482cf66c5dc46959389dcbc',
    );
  });

  it('freezes crypto-usdt-v1 exactly as committed, with an input hash per member', () => {
    expect(CRYPTO_RESEARCH_SPECIFICATION.universe.members).toEqual(CRYPTO_TRADINGVIEW_SYMBOLS);
    const { rule, ...hashes } = CRYPTO_RESEARCH_SPECIFICATION.data.inputHashes;
    expect(rule).toMatch(/stableSerialize/);
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(CRYPTO_TRADINGVIEW_SYMBOLS).sort());
  });
});
