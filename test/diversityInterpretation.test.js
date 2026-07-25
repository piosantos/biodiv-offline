import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Biodiversity from '../src/utils/biodiversity.js';
import DiversityInterpretation from '../src/utils/diversityInterpretation.js';

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

function interpret(observations) {
  return DiversityInterpretation.describeAnalysis(Biodiversity.buildAnalysis(observations));
}

describe('diversity interpretation', () => {
  it('describes absent observations as no valid data without a threshold class', () => {
    const result = interpret([]);

    expect(result).toMatchObject({
      state: 'no_valid_data',
      includedRecordCount: 0,
      excludedRecordCount: 0,
      summary: 'Belum ada observasi yang dicatat.'
    });
    expect(JSON.stringify(result)).not.toMatch(/rendah|sedang|tinggi/i);
  });

  it('handles an empty valid analysis object without mutating its fields', () => {
    const analysis = {
      includedRecords: [],
      excludedRecords: [],
      totalCategories: 0,
      totalIndividuals: 0,
      shannonIndex: 0
    };

    expect(DiversityInterpretation.describeAnalysis(analysis)).toMatchObject({
      state: 'no_valid_data',
      totalRecordedObservationCount: 0
    });
    expect(analysis).toEqual({
      includedRecords: [],
      excludedRecords: [],
      totalCategories: 0,
      totalIndividuals: 0,
      shannonIndex: 0
    });
  });

  it('explains one included category as a sample property rather than a location-wide finding', () => {
    const result = interpret([observation('Daun', 5)]);

    expect(result.state).toBe('single_category');
    expect(result.shannonIndex).toBe(0);
    expect(result.summary).toContain('seluruh individu valid dalam sampel ini');
    expect(result.summary).toContain('tidak membuktikan bahwa lokasi tidak memiliki');
  });

  it('describes multiple categories without quality, causal, or universal-threshold claims', () => {
    const result = interpret([observation('Daun', 5), observation('Semut', 3, { id: 1 })]);
    const text = `${result.summary} ${result.methodologicalNote} ${result.comparisonNote}`;

    expect(result.state).toBe('multiple_categories');
    expect(text).toContain('Pada sampel ini');
    expect(text).not.toMatch(/ekosistem sehat|kualitas ekosistem|polusi|teduh|rendah|sedang|tinggi/i);
  });

  it('counts included, excluded, unresolved, and invalid observations separately', () => {
    const result = interpret([
      observation('Daun', 5),
      observation('', 1, { id: 1, verificationStatus: 'unresolved', taxonomicLevel: 'unknown' }),
      observation('Semut', 0, { id: 2 })
    ]);

    expect(result).toMatchObject({
      includedRecordCount: 1,
      excludedRecordCount: 2,
      unresolvedRecordCount: 1,
      invalidRecordCount: 1,
      totalRecordedObservationCount: 3
    });
    expect(result.exclusionCounts).toEqual({ non_positive_count: 1, unresolved_identification: 1 });
    expect(result.totalRecordedObservationCount).toBe(result.includedRecordCount + result.excludedRecordCount);
    expect(result.excludedRecordCount).toBe(result.unresolvedRecordCount + result.invalidRecordCount);
  });

  it('formats known and unknown exclusion reasons safely', () => {
    expect(DiversityInterpretation.formatExclusionReason('missing_count')).toBe('Jumlah individu belum diisi');
    expect(DiversityInterpretation.formatExclusionReason('future_reason')).toBe('Data observasi tidak valid');

    expect(DiversityInterpretation.summarizeExclusions({
      excludedRecords: [
        { reason: 'future_reason' },
        { reason: 'future_reason' },
        { reason: 'unresolved_identification' }
      ]
    })).toMatchObject({
      excludedRecordCount: 3,
      unresolvedRecordCount: 1,
      invalidRecordCount: 2,
      exclusionCounts: { future_reason: 2, unresolved_identification: 1 }
    });
  });

  it('preserves accounting invariants for no exclusions, unresolved, invalid, shared, and repeated reasons', () => {
    const cases = [
      [],
      [observation('', 1, { verificationStatus: 'unresolved', taxonomicLevel: 'unknown' })],
      [observation('Daun', 0)],
      [
        observation('', 1, { verificationStatus: 'unresolved', taxonomicLevel: 'unknown' }),
        observation('Daun', 0, { id: 1 })
      ],
      [observation('Daun', 0), observation('Semut', 0, { id: 1 })],
      [observation('Daun', 0), observation('Semut', 0.5, { id: 1 })]
    ];

    cases.forEach((observations) => {
      const result = interpret(observations);
      expect(result.totalRecordedObservationCount).toBe(result.includedRecordCount + result.excludedRecordCount);
      expect(result.excludedRecordCount).toBe(result.unresolvedRecordCount + result.invalidRecordCount);
    });
  });

  it('labels sample-only data as a demonstration dataset', () => {
    const result = interpret([observation('Daun', 5, { recordSource: 'sample' })]);

    expect(result.sourceState).toBe('sample_only');
    expect(result.sourceNote).toBe('Data ini adalah data contoh untuk demonstrasi, bukan hasil survei lapangan.');
  });

  it('does not add a sample warning to user-only data', () => {
    expect(interpret([observation('Daun', 5)])).toMatchObject({ sourceState: 'user_only', sourceNote: '' });
  });

  it('warns when sample and user records are mixed', () => {
    const result = interpret([
      observation('Daun', 5, { recordSource: 'sample' }),
      observation('Semut', 2, { id: 1 })
    ]);

    expect(result.sourceState).toBe('mixed');
    expect(result.sourceNote).toContain('mencampurkan data contoh dan observasi pengguna');
  });

  it('derives source composition from all records, including excluded observations', () => {
    const includedUserExcludedSample = interpret([
      observation('Daun', 5),
      observation('Contoh', 0, { id: 1, recordSource: 'sample' })
    ]);
    const includedSampleExcludedUser = interpret([
      observation('Daun', 5, { recordSource: 'sample' }),
      observation('Pengguna', 0, { id: 1 })
    ]);

    expect(includedUserExcludedSample).toMatchObject({ sourceState: 'mixed' });
    expect(includedSampleExcludedUser).toMatchObject({ sourceState: 'mixed' });
    expect(includedUserExcludedSample.sourceNote).toContain('tidak boleh ditafsirkan sebagai satu sampel lapangan yang koheren');
  });

  it('marks incomplete or invalid source composition instead of silently calling it user or sample only', () => {
    const recognizedAndInvalid = interpret([
      observation('Daun', 5),
      observation('Tidak sah', 0, { id: 1, recordSource: 'other' })
    ]);
    const invalidOnly = interpret([observation('Tidak sah', 0, { recordSource: 'other' })]);

    expect(recognizedAndInvalid).toMatchObject({ sourceState: 'partially_unknown', unknownSourceCount: 1 });
    expect(invalidOnly).toMatchObject({ sourceState: 'partially_unknown', unknownSourceCount: 1 });
    expect(recognizedAndInvalid.sourceNote).toContain('Sumber sebagian observasi tidak dicatat atau tidak valid');
  });

  it('always supplies operational-category and comparable-method limitations', () => {
    const result = interpret([observation('Daun', 5)]);

    expect(result.methodologicalNote).toContain('tidak otomatis setara dengan spesies');
    expect(result.comparisonNote).toContain('metode, area, waktu, durasi, upaya sampling');
  });

  it('is deterministic and does not mutate the analysis object', () => {
    const analysis = Biodiversity.buildAnalysis([observation('Daun', 5)]);
    const before = structuredClone(analysis);

    expect(DiversityInterpretation.describeAnalysis(analysis)).toEqual(
      DiversityInterpretation.describeAnalysis(analysis)
    );
    expect(analysis).toEqual(before);
  });

  it('gives the known four-category sample neutral sample-bounded wording', () => {
    const result = interpret([
      observation('Daun', 5, { recordSource: 'sample' }),
      observation('Bunga Merah', 3, { id: 1, recordSource: 'sample' }),
      observation('Kupu-kupu', 2, { id: 2, recordSource: 'sample' }),
      observation('Semut', 4, { id: 3, recordSource: 'sample' })
    ]);

    expect(result.shannonIndex).toBeCloseTo(1.3337360272, 10);
    expect(result.summary).toContain('Pada sampel ini');
    expect(result.sourceNote).toContain('data contoh untuk demonstrasi');
  });

  it('distinguishes unresolved-only and invalid-count-only no-data scenarios', () => {
    const unresolved = interpret([observation('', 1, {
      verificationStatus: 'unresolved',
      taxonomicLevel: 'unknown'
    })]);
    const invalid = interpret([observation('Daun', 0)]);

    expect(unresolved).toMatchObject({ state: 'no_valid_data', unresolvedRecordCount: 1, invalidRecordCount: 0 });
    expect(invalid).toMatchObject({ state: 'no_valid_data', unresolvedRecordCount: 0, invalidRecordCount: 1 });
    expect(unresolved.summary).toContain('masih belum teridentifikasi');
    expect(invalid.summary).toContain('data tidak valid');
    expect(invalid.exclusionSummary).toContain('Jumlah individu harus lebih dari nol');
  });

  it('discloses mixed unresolved and invalid no-data records without double counting either group', () => {
    const result = interpret([
      observation('', 1, { verificationStatus: 'unresolved', taxonomicLevel: 'unknown' }),
      observation('Daun', 0, { id: 1 })
    ]);

    expect(result).toMatchObject({
      state: 'no_valid_data',
      includedRecordCount: 0,
      excludedRecordCount: 2,
      unresolvedRecordCount: 1,
      invalidRecordCount: 1
    });
    expect(result.summary).toContain('belum teridentifikasi dan data tidak valid');
  });

  it('reports a valid plus unresolved sample as one included and one excluded observation', () => {
    const result = interpret([
      observation('Daun', 5),
      observation('', 1, { id: 1, verificationStatus: 'unresolved', taxonomicLevel: 'unknown' })
    ]);

    expect(result).toMatchObject({
      state: 'single_category',
      includedRecordCount: 1,
      excludedRecordCount: 1,
      unresolvedRecordCount: 1,
      invalidRecordCount: 0
    });
  });
});

describe('interpretation source contracts', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const serviceWorkerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');

  it('loads the interpretation module before application code and precaches it under v17', () => {
    const modulePosition = source.indexOf('<script src="src/utils/diversityInterpretation.js"></script>');
    const applicationPosition = source.indexOf("document.addEventListener('DOMContentLoaded'");

    expect(modulePosition).toBeGreaterThan(-1);
    expect(modulePosition).toBeLessThan(applicationPosition);
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./src/utils/diversityInterpretation.js'");
  });

  it('uses the interpretation module in Analyze, Report, and Coach paths', () => {
    expect(source).toContain("Biodiversity.buildAnalysis(surveyData.filter((record) => record && typeof record === 'object'))");
    expect(source).toContain('DiversityInterpretation.describeAnalysis');
    expect(source).toContain('DiversityInterpretation.describeAnalysis(analysis, surveyData)');
    expect(source).toContain('function renderAnalysisInterpretation');
    expect(source).toContain('function generateReportContent');
    expect(source).toContain('function sendMessage');
  });

  it('removes the old Shannon threshold function and unbounded high-H question', () => {
    expect(source).not.toContain('function analysisInterpretation');
    expect(source).not.toContain("analysis.shannonIndex > 1.5");
    expect(source).not.toContain("analysis.shannonIndex > 1.0");
    expect(source).not.toContain("Apa arti nilai indeks Shannon (H') yang lebih tinggi?");
  });
});
