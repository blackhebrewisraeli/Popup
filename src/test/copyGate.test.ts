import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

/**
 * Copy gate (M1-T4, F-6.1c): user-facing surfaces describing the Quant
 * Analyzer must not brand the deterministic multi-factor engine as "AI". "AI"
 * is reserved for a future, PO-gated explanation layer (roadmap M2-11).
 */
const SURFACES = ['src/routes/_workspace.index.tsx', 'src/components/Workspace.tsx', 'README.md'];

describe('Quant Analyzer branding copy gate', () => {
  it.each(SURFACES)('%s contains no standalone "AI" branding', (file) => {
    expect(read(file)).not.toMatch(/\bAI\b/);
  });
});

/**
 * The product is a private research workspace; copy must not promise
 * more than that (architecture review, phase 5).
 */
const PROMISE_SURFACES = [
  ...SURFACES,
  'src/components/AccountPanel.tsx',
  'src/lib/portfolioManager.ts',
  'package.json',
];

describe('product promise copy gate', () => {
  it.each(PROMISE_SURFACES)('%s makes no over-promising claims', (file) => {
    expect(read(file)).not.toMatch(
      /institutional|wealth management|robo[- ]advisor|zero (financial )?knowledge/i,
    );
  });
});
