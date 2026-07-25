import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Biodiversity from '../src/utils/biodiversity.js';

function observation(finalLabel, count, overrides = {}) {
  return {
    id: 0,
    finalLabel,
    taxonomicLevel: 'broad_category',
    verificationStatus: 'unverified',
    verificationEvidence: '',
    count,
    recordSource: 'user',
    ...overrides
  };
}

const sampleData = [
  observation('Daun', 5),
  observation('Bunga Merah', 3),
  observation('Kupu-kupu', 2),
  observation('Semut', 4)
];

describe('buildAnalysis', () => {
  it('returns an explicit zero analysis for an empty array', () => {
    expect(Biodiversity.buildAnalysis([])).toEqual({
      includedRecords: [],
      excludedRecords: [],
      categoryCounts: {},
      totalCategories: 0,
      totalIndividuals: 0,
      shannonIndex: 0,
      warnings: []
    });
  });

  it('handles arrays containing only null and undefined holes', () => {
    const observations = [null, undefined];
    observations.length = 3;
    const analysis = Biodiversity.buildAnalysis(observations);

    expect(analysis.totalCategories).toBe(0);
    expect(analysis.totalIndividuals).toBe(0);
    expect(analysis.shannonIndex).toBe(0);
    expect(analysis.warnings).toEqual([
      { index: 0, reason: 'missing_record' },
      { index: 1, reason: 'missing_record' },
      { index: 2, reason: 'missing_record' }
    ]);
  });

  it('returns zero Shannon diversity for one valid category', () => {
    const analysis = Biodiversity.buildAnalysis([observation('Daun', 5)]);

    expect(analysis.categoryCounts).toEqual({ Daun: 5 });
    expect(analysis.totalCategories).toBe(1);
    expect(analysis.totalIndividuals).toBe(5);
    expect(analysis.shannonIndex).toBe(0);
  });

  it('calculates multiple categories with the natural logarithm', () => {
    const analysis = Biodiversity.buildAnalysis([
      observation('A', 1),
      observation('B', 1)
    ]);

    expect(analysis.totalCategories).toBe(2);
    expect(analysis.totalIndividuals).toBe(2);
    expect(analysis.shannonIndex).toBeCloseTo(Math.log(2), 12);
  });

  it('aggregates repeated labels before calculating totals and Shannon diversity', () => {
    const analysis = Biodiversity.buildAnalysis([
      observation('Daun', 2),
      observation('Daun', 3),
      observation('Semut', 5)
    ]);

    expect(analysis.categoryCounts).toEqual({ Daun: 5, Semut: 5 });
    expect(analysis.totalCategories).toBe(2);
    expect(analysis.totalIndividuals).toBe(10);
    expect(analysis.shannonIndex).toBeCloseTo(Math.log(2), 12);
  });

  it('calculates the known sample dataset', () => {
    const analysis = Biodiversity.buildAnalysis(sampleData);

    expect(analysis.categoryCounts).toEqual({
      Daun: 5,
      'Bunga Merah': 3,
      'Kupu-kupu': 2,
      Semut: 4
    });
    expect(analysis.totalCategories).toBe(4);
    expect(analysis.totalIndividuals).toBe(14);
    expect(analysis.shannonIndex).toBeCloseTo(1.3337, 4);
  });

  it('accepts the UI maximum count of 999', () => {
    const analysis = Biodiversity.buildAnalysis([observation('Daun', 999)]);

    expect(analysis.categoryCounts).toEqual({ Daun: 999 });
    expect(analysis.totalIndividuals).toBe(999);
    expect(analysis.warnings).toEqual([]);
  });

  it('uses finalLabel as the sole authoritative category label', () => {
    const analysis = Biodiversity.buildAnalysis([
      observation('Label akhir', 2, { label: 'Label lama' })
    ]);

    expect(analysis.categoryCounts).toEqual({ 'Label akhir': 2 });
    expect(analysis.categoryCounts).not.toHaveProperty('Label lama');
  });

  it('does not accept a legacy label when finalLabel is absent', () => {
    const record = observation(undefined, 2, { label: 'Label lama' });
    const analysis = Biodiversity.buildAnalysis([record]);

    expect(analysis.categoryCounts).toEqual({});
    expect(analysis.warnings).toEqual([{ index: 0, reason: 'invalid_final_label' }]);
  });

  it('excludes a malformed unresolved final label before category aggregation', () => {
    const record = observation('Label yang tidak boleh dihitung', 1, {
      taxonomicLevel: 'unknown',
      verificationStatus: 'unresolved'
    });
    const analysis = Biodiversity.buildAnalysis([record]);

    expect(analysis.categoryCounts).toEqual({});
    expect(analysis.totalCategories).toBe(0);
    expect(analysis.totalIndividuals).toBe(0);
    expect(analysis.shannonIndex).toBe(0);
    expect(analysis.warnings).toEqual([{ index: 0, reason: 'unresolved_identification' }]);
  });

  it.each([
    [observation('', 1), 'invalid_final_label'],
    [observation('Daun', undefined), 'missing_count'],
    [observation('Daun', ''), 'non_numeric_count'],
    [observation('Daun', 0), 'non_positive_count'],
    [observation('Daun', -1), 'non_positive_count'],
    [observation('Daun', 1.5), 'fractional_count'],
    [observation('Daun', '5'), 'non_numeric_count'],
    [observation('Daun', 1000), 'count_above_maximum'],
    [observation('Daun', Number.MAX_SAFE_INTEGER), 'count_above_maximum'],
    [observation('x'.repeat(121), 1), 'final_label_too_long'],
    [observation('Daun', 1, { id: '0' }), 'invalid_record_id'],
    [observation('Daun', 1, {
      verificationStatus: 'verified',
      verificationEvidence: 'b'.repeat(1001)
    }), 'verification_evidence_too_long']
  ])('excludes invalid record %# with a stable reason', (record, reason) => {
    const analysis = Biodiversity.buildAnalysis([record]);

    expect(analysis.includedRecords).toEqual([]);
    expect(analysis.excludedRecords).toEqual([{ index: 0, record, reason }]);
    expect(analysis.warnings).toEqual([{ index: 0, reason }]);
  });

  it('distinguishes non-finite counts from other invalid counts', () => {
    const analysis = Biodiversity.buildAnalysis([
      observation('A', Number.NaN),
      observation('B', Number.POSITIVE_INFINITY)
    ]);

    expect(analysis.warnings).toEqual([
      { index: 0, reason: 'non_finite_count' },
      { index: 1, reason: 'non_finite_count' }
    ]);
  });

  it('preserves valid numeric counts and original record objects', () => {
    const record = observation('Daun', 5, { id: 7, metadata: { source: 'manual' } });
    const analysis = Biodiversity.buildAnalysis([record]);

    expect(analysis.includedRecords[0]).toBe(record);
    expect(record.count).toBe(5);
    expect(typeof record.count).toBe('number');
  });

  it('does not mutate a frozen input array or its records', () => {
    const first = Object.freeze(observation('Daun', 2));
    const second = Object.freeze(observation('Semut', 3));
    const observations = Object.freeze([first, second]);

    expect(() => Biodiversity.buildAnalysis(observations)).not.toThrow();
    expect(observations).toEqual([first, second]);
  });

  it('returns the same output for repeated calls with the same input', () => {
    const first = Biodiversity.buildAnalysis(sampleData);
    const second = Biodiversity.buildAnalysis(sampleData);

    expect(second).toEqual(first);
  });

  it('includes a record again after an invalid count is corrected', () => {
    const record = observation('Daun', 1000);
    expect(Biodiversity.buildAnalysis([record]).warnings).toEqual([
      { index: 0, reason: 'count_above_maximum' }
    ]);

    record.count = 10;
    const corrected = Biodiversity.buildAnalysis([record]);
    expect(corrected.categoryCounts).toEqual({ Daun: 10 });
    expect(corrected.totalIndividuals).toBe(10);
    expect(corrected.warnings).toEqual([]);
  });

  it('returns a stable warning for a non-array input', () => {
    expect(Biodiversity.buildAnalysis(null).warnings).toEqual([
      { index: null, reason: 'invalid_observations' }
    ]);
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'retains the prototype-like label %s as an ordinary category',
    (label) => {
      const originalPrototype = Object.getPrototypeOf({});
      const analysis = Biodiversity.buildAnalysis([
        observation(label, 2),
        observation(label, 1)
      ]);

      expect(Object.prototype.hasOwnProperty.call(analysis.categoryCounts, label)).toBe(true);
      expect(analysis.categoryCounts[label]).toBe(3);
      expect(Object.keys(analysis.categoryCounts)).toContain(label);
      expect(Object.getPrototypeOf(analysis.categoryCounts)).toBe(originalPrototype);
      expect(Object.getPrototypeOf({})).toBe(originalPrototype);
      expect(analysis.totalCategories).toBe(1);
      expect(analysis.totalIndividuals).toBe(3);
    }
  );
});

describe('biodiversity source integration', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const serviceWorkerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');
  const reportSource = source.slice(
    source.indexOf('function generateReportContent'),
    source.indexOf('async function downloadReport')
  );
  const practiceSource = source.slice(
    source.indexOf('function generateQuiz'),
    source.indexOf('function runPreQuiz')
  );

  it('loads the biodiversity module before application code', () => {
    const modulePosition = source.indexOf('<script src="src/utils/biodiversity.js"></script>');
    const applicationPosition = source.indexOf("document.addEventListener('DOMContentLoaded'");

    expect(modulePosition).toBeGreaterThan(-1);
    expect(modulePosition).toBeLessThan(applicationPosition);
  });

  it('precaches the biodiversity module under the next cache generation', () => {
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./src/utils/assessment.js'");
    expect(serviceWorkerSource).toContain("'./src/utils/biodiversity.js'");
  });

  it('does not declare mutable global speciesCounts state', () => {
    expect(source).not.toMatch(/\b(?:let|var|const)\s+speciesCounts\b/);
  });

  it('builds reports from current domain analysis rather than metric-card text', () => {
    expect(reportSource).toContain('const analysis = currentAnalysis()');
    expect(reportSource).not.toMatch(/getElementById\(['"](?:totalSpecies|totalIndividuals|shannonIndex)['"]\)\.textContent/);
  });

  it('builds practice questions from current domain analysis', () => {
    expect(practiceSource).toContain('const analysis = currentAnalysis()');
    expect(practiceSource).toContain('String(analysis.totalCategories)');
  });

  it('refreshes report content immediately before PDF capture', () => {
    const downloadSource = source.slice(source.indexOf('async function downloadReport'));
    expect(downloadSource.indexOf('generateReportContent()')).toBeLessThan(
      downloadSource.indexOf("document.getElementById('report-content-wrapper')")
    );
  });

});
