import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ObservationRecord from '../src/utils/observationRecord.js';
import Biodiversity from '../src/utils/biodiversity.js';

function validDraft(overrides = {}) {
  return {
    id: 1,
    imgSrc: 'data:image/png;base64,example',
    modelCandidate: null,
    finalLabel: 'Daun',
    taxonomicLevel: 'broad_category',
    verificationStatus: 'unverified',
    verificationEvidence: '',
    count: 1,
    recordSource: 'user',
    ...overrides
  };
}

describe('canonical observation text', () => {
  it('preserves HTML-significant characters as canonical text', () => {
    expect(ObservationRecord.canonicalizeLabel('A & B <contoh>')).toBe('A & B <contoh>');
  });

  it('trims surrounding whitespace', () => {
    expect(ObservationRecord.canonicalizeLabel('  Nematode tanah  ')).toBe('Nematode tanah');
  });

  it('normalizes line endings and removes unsupported control characters', () => {
    expect(ObservationRecord.canonicalizeLabel('A\r\nB\u0000\u0007C')).toBe('A BC');
  });

  it('preserves ordinary Indonesian and scientific-name Unicode', () => {
    expect(ObservationRecord.canonicalizeLabel('Kupu-kupu — Rhopalocera café')).toBe('Kupu-kupu — Rhopalocera café');
  });

  it('accepts a 120-code-unit label unchanged', () => {
    const label = 'x'.repeat(ObservationRecord.LABEL_MAX_LENGTH);
    const validation = ObservationRecord.validateObservationDraft(validDraft({ finalLabel: label }));

    expect(validation.valid).toBe(true);
    expect(validation.draft.finalLabel).toBe(label);
  });

  it('rejects a 121-code-unit label without silently shortening it', () => {
    const label = 'x'.repeat(ObservationRecord.LABEL_MAX_LENGTH + 1);
    const validation = ObservationRecord.validateObservationDraft(validDraft({ finalLabel: label }));

    expect(ObservationRecord.canonicalizeLabel(label)).toBe(label);
    expect(validation.draft.finalLabel).toBe(label);
    expect(validation.errors).toContain('final_label_too_long');
    expect(ObservationRecord.createObservationRecord(validDraft({ finalLabel: label })).record).toBeNull();
  });

  it('measures limits in UTF-16 code units', () => {
    const accepted = `${'x'.repeat(118)}😀`;
    const rejected = `${'x'.repeat(119)}😀`;

    expect(accepted.length).toBe(120);
    expect(ObservationRecord.validateObservationDraft(validDraft({ finalLabel: accepted })).valid).toBe(true);
    expect(rejected.length).toBe(121);
    expect(ObservationRecord.validateObservationDraft(validDraft({ finalLabel: rejected })).errors)
      .toContain('final_label_too_long');
  });

  it('preserves evidence line breaks while normalizing CRLF', () => {
    expect(ObservationRecord.canonicalizeEvidence('  Panduan A\r\nFoto pembanding\nCatatan  '))
      .toBe('Panduan A\nFoto pembanding\nCatatan');
  });

  it('accepts 1,000 evidence code units unchanged', () => {
    const evidence = 'b'.repeat(ObservationRecord.EVIDENCE_MAX_LENGTH);
    const validation = ObservationRecord.validateObservationDraft(validDraft({
      verificationStatus: 'verified',
      verificationEvidence: evidence
    }));

    expect(validation.valid).toBe(true);
    expect(validation.draft.verificationEvidence).toBe(evidence);
  });

  it('rejects 1,001 evidence code units without silently shortening them', () => {
    const evidence = 'b'.repeat(ObservationRecord.EVIDENCE_MAX_LENGTH + 1);
    const validation = ObservationRecord.validateObservationDraft(validDraft({
      verificationStatus: 'verified',
      verificationEvidence: evidence
    }));

    expect(ObservationRecord.canonicalizeEvidence(evidence)).toBe(evidence);
    expect(validation.draft.verificationEvidence).toBe(evidence);
    expect(validation.errors).toContain('verification_evidence_too_long');
    expect(ObservationRecord.createObservationRecord(validDraft({
      verificationStatus: 'verified',
      verificationEvidence: evidence
    })).record).toBeNull();
  });

  it('does not produce HTML entities in canonical label or evidence data', () => {
    expect(ObservationRecord.canonicalizeLabel('A & B <contoh>')).not.toMatch(/&(?:amp|lt|gt);/);
    expect(ObservationRecord.canonicalizeEvidence('Bukti <foto> & catatan')).toBe('Bukti <foto> & catatan');
  });
});

describe('model candidate normalization', () => {
  it('retains a valid candidate as structured data', () => {
    expect(ObservationRecord.normalizeModelCandidate({
      rawClassName: 'nematode, roundworm',
      suggestedLabel: 'Nematode',
      score: 0.049
    })).toEqual({
      rawClassName: 'nematode, roundworm',
      suggestedLabel: 'Nematode',
      score: 0.049
    });
  });

  it.each([0, 1])('accepts boundary score %s', (score) => {
    expect(ObservationRecord.normalizeModelCandidate({
      rawClassName: 'leaf',
      suggestedLabel: 'Daun',
      score
    })?.score).toBe(score);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '0.9'])(
    'normalizes invalid score %s to null',
    (score) => {
      expect(ObservationRecord.normalizeModelCandidate({
        rawClassName: 'leaf',
        suggestedLabel: 'Daun',
        score
      })?.score).toBeNull();
    }
  );

  it('does not infer verification status from a high model score', () => {
    const result = ObservationRecord.createObservationRecord(validDraft({
      modelCandidate: { rawClassName: 'leaf', suggestedLabel: 'Daun', score: 1 }
    }));

    expect(result.record?.verificationStatus).toBe('unverified');
  });
});

describe('observation draft validation', () => {
  it.each([0, 17])('accepts valid record ID %s', (id) => {
    const result = ObservationRecord.createObservationRecord(validDraft({ id }));

    expect(result.errors).toEqual([]);
    expect(result.record?.id).toBe(id);
  });

  it.each([
    ['missing', undefined],
    ['negative', -1],
    ['fractional', 1.5],
    ['numeric string', '1']
  ])('rejects a %s record ID without returning a record', (_description, id) => {
    const result = ObservationRecord.createObservationRecord(validDraft({ id }));

    expect(result.record).toBeNull();
    expect(result.errors).toContain('invalid_record_id');
  });

  it('does not collapse multiple invalid IDs into fabricated ID 0 records', () => {
    const missing = ObservationRecord.createObservationRecord(validDraft({ id: undefined }));
    const negative = ObservationRecord.createObservationRecord(validDraft({ id: -4 }));

    expect(missing.record).toBeNull();
    expect(negative.record).toBeNull();
    expect([missing.record, negative.record]).not.toContainEqual(expect.objectContaining({ id: 0 }));
  });

  it('requires a final label for an unverified observation', () => {
    expect(ObservationRecord.validateObservationDraft(validDraft({ finalLabel: '' })).errors)
      .toContain('missing_final_label');
  });

  it('requires a non-unknown level for an unverified observation', () => {
    expect(ObservationRecord.validateObservationDraft(validDraft({ taxonomicLevel: 'unknown' })).errors)
      .toContain('unknown_taxonomic_level');
  });

  it.each(['probable', 'verified'])('requires evidence for %s status', (verificationStatus) => {
    expect(ObservationRecord.validateObservationDraft(validDraft({ verificationStatus })).errors)
      .toContain('missing_verification_evidence');
  });

  it('allows an unresolved observation with an empty final label', () => {
    const validation = ObservationRecord.validateObservationDraft(validDraft({
      finalLabel: '',
      taxonomicLevel: 'species',
      verificationStatus: 'unresolved'
    }));

    expect(validation.valid).toBe(true);
    expect(validation.draft.finalLabel).toBe('');
  });

  it('accepts an empty-label unresolved observation and forces its level to unknown', () => {
    const result = ObservationRecord.createObservationRecord(validDraft({
      finalLabel: '',
      taxonomicLevel: 'species',
      verificationStatus: 'unresolved'
    }));

    expect(result.record?.taxonomicLevel).toBe('unknown');
    expect(result.record?.finalLabel).toBe('');
  });

  it('rejects an unresolved observation with a canonical final label instead of discarding it', () => {
    const draft = validDraft({
      finalLabel: 'Nematode tanah',
      taxonomicLevel: 'species',
      verificationStatus: 'unresolved'
    });
    const validation = ObservationRecord.validateObservationDraft(draft);
    const result = ObservationRecord.createObservationRecord(draft);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('unresolved_final_label_present');
    expect(validation.draft).toMatchObject({
      finalLabel: 'Nematode tanah',
      taxonomicLevel: 'unknown',
      verificationStatus: 'unresolved'
    });
    expect(result).toEqual({ record: null, errors: ['unresolved_final_label_present'] });
  });

  it('rejects an invalid verification status with a stable reason', () => {
    expect(ObservationRecord.validateObservationDraft(validDraft({ verificationStatus: 'certain' })).errors)
      .toContain('invalid_verification_status');
  });

  it('rejects an invalid taxonomic level with a stable reason', () => {
    expect(ObservationRecord.validateObservationDraft(validDraft({ taxonomicLevel: 'order' })).errors)
      .toContain('invalid_taxonomic_level');
  });

  it('validates record source', () => {
    expect(ObservationRecord.validateObservationDraft(validDraft({ recordSource: 'model' })).errors)
      .toContain('invalid_record_source');
  });

  it('returns deterministic machine-readable validation reasons', () => {
    const invalid = validDraft({
      finalLabel: '',
      taxonomicLevel: 'unknown',
      verificationStatus: 'verified',
      verificationEvidence: '',
      count: 1000,
      recordSource: 'model'
    });

    expect(ObservationRecord.validateObservationDraft(invalid).errors).toEqual([
      'invalid_record_source',
      'missing_final_label',
      'unknown_taxonomic_level',
      'missing_verification_evidence',
      'count_above_maximum'
    ]);
  });
});

describe('analysis eligibility and canonical category use', () => {
  it('excludes unresolved records from category and Shannon analysis', () => {
    const record = ObservationRecord.createObservationRecord(validDraft({
      finalLabel: '',
      verificationStatus: 'unresolved'
    })).record;
    const analysis = Biodiversity.buildAnalysis([record]);

    expect(ObservationRecord.isAnalysisEligible(record)).toBe(false);
    expect(analysis.totalCategories).toBe(0);
    expect(analysis.warnings).toEqual([{ index: 0, reason: 'unresolved_identification' }]);
  });

  it('excludes a malformed unresolved label before it can become a category', () => {
    const record = validDraft({
      finalLabel: 'Label yang tidak boleh dihitung',
      taxonomicLevel: 'unknown',
      verificationStatus: 'unresolved'
    });
    const analysis = Biodiversity.buildAnalysis([record]);

    expect(analysis.categoryCounts).toEqual({});
    expect(analysis.warnings).toEqual([{ index: 0, reason: 'unresolved_identification' }]);
  });

  it('includes a valid unverified record as an operational category', () => {
    const record = ObservationRecord.createObservationRecord(validDraft()).record;
    expect(ObservationRecord.isAnalysisEligible(record)).toBe(true);
    expect(Biodiversity.buildAnalysis([record]).categoryCounts).toEqual({ Daun: 1 });
  });

  it.each(['probable', 'verified'])('includes a valid %s record', (verificationStatus) => {
    const record = ObservationRecord.createObservationRecord(validDraft({
      verificationStatus,
      verificationEvidence: 'Panduan lapangan halaman 10'
    })).record;

    expect(ObservationRecord.isAnalysisEligible(record)).toBe(true);
    expect(Biodiversity.buildAnalysis([record]).totalCategories).toBe(1);
  });

  it('does not treat a model candidate alone as analysis evidence', () => {
    const record = validDraft({
      finalLabel: '',
      modelCandidate: { rawClassName: 'leaf', suggestedLabel: 'Daun', score: 0.99 }
    });

    expect(ObservationRecord.isAnalysisEligible(record)).toBe(false);
    expect(Biodiversity.buildAnalysis([record]).warnings).toEqual([
      { index: 0, reason: 'invalid_final_label' }
    ]);
  });

  it('excludes a record with an invalid provenance value', () => {
    const analysis = Biodiversity.buildAnalysis([validDraft({ recordSource: 'model' })]);

    expect(analysis.warnings).toEqual([{ index: 0, reason: 'invalid_record_source' }]);
  });

  it('does not let candidate score affect eligibility', () => {
    const low = ObservationRecord.createObservationRecord(validDraft({
      modelCandidate: { rawClassName: 'leaf', suggestedLabel: 'Daun', score: 0 }
    })).record;
    const high = ObservationRecord.createObservationRecord(validDraft({
      modelCandidate: { rawClassName: 'leaf', suggestedLabel: 'Daun', score: 1 }
    })).record;

    expect(ObservationRecord.isAnalysisEligible(low)).toBe(true);
    expect(ObservationRecord.isAnalysisEligible(high)).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'retains canonical prototype-like final label %s safely',
    (finalLabel) => {
      const record = ObservationRecord.createObservationRecord(validDraft({ finalLabel, count: 2 })).record;
      const analysis = Biodiversity.buildAnalysis([record]);

      expect(Object.keys(analysis.categoryCounts)).toContain(finalLabel);
      expect(Object.prototype.hasOwnProperty.call(analysis.categoryCounts, finalLabel)).toBe(true);
      expect(analysis.categoryCounts[finalLabel]).toBe(2);
      expect(Object.getPrototypeOf(analysis.categoryCounts)).toBe(Object.prototype);
    }
  );
});

describe('observation source integration contracts', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const serviceWorkerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');
  const classificationResultSource = source.slice(
    source.indexOf('function renderClassificationResult'),
    source.indexOf('async function classifyImageForRequest')
  );
  const currentValidationSource = source.slice(
    source.indexOf('function currentObservationValidation'),
    source.indexOf('function renderObservationValidation')
  );
  const saveSource = source.slice(
    source.indexOf('function saveOrganismData'),
    source.indexOf('function updateCardDisplay')
  );
  const reportSource = source.slice(
    source.indexOf('function appendReportField'),
    source.indexOf('async function downloadReport')
  );

  it('reframes the modal without unsupported identification wording', () => {
    expect(source).toContain('Kandidat Identifikasi');
    expect(source).toContain('Kandidat dari Model');
    expect(source).toContain('Skor model');
    expect(source).not.toContain('Identifikasi Spesies');
    expect(source).not.toContain('Prediksi AI');
  });

  it('does not automatically assign the candidate to the final-label field', () => {
    expect(classificationResultSource).toContain('pendingClassification.modelCandidate = candidate');
    expect(classificationResultSource).not.toMatch(/finalLabelInput\.value\s*=\s*(?:candidate|mapToLocalLabel)/);
  });

  it('renders unavailable or invalid candidate scores as Tidak ada', () => {
    expect(classificationResultSource).toContain('candidate && candidate.score !== null');
    expect(classificationResultSource).toContain(": 'Tidak ada'");
    expect(classificationResultSource).not.toMatch(/(?:NaN|Infinity)%/);
  });

  it('provides an explicit candidate-copy control', () => {
    expect(source).toContain('Gunakan kandidat sebagai label awal');
    expect(source).toContain('function adoptModelCandidate()');
    expect(source).toContain('finalLabelInput.value = candidate.suggestedLabel');
  });

  it('saves request-bound structured observation data without sanitizing canonical storage', () => {
    expect(saveSource).toContain('ObservationRecord.createObservationRecord');
    expect(saveSource).toContain('id: cardIndex');
    expect(saveSource).toContain('modelCandidate: pendingClassification.modelCandidate');
    expect(saveSource).toContain('...pendingClassification.observationDraft');
    expect(saveSource).not.toContain('sanitizeLabel(');
  });

  it('uses the active request card ID during validation and save', () => {
    expect(currentValidationSource).toContain('id: pendingClassification.cardIndex');
    expect(saveSource).toContain('const cardIndex = activeRequest.cardIndex');
    expect(saveSource).toContain('id: cardIndex');
  });

  it('guards draft mutation and candidate adoption with request ownership', () => {
    const draftSource = source.slice(
      source.indexOf('function updateObservationDraft'),
      source.indexOf('function requestOwnsPendingClassification')
    );

    expect(draftSource.match(/requestOwnsPendingModal\(activeRequest\)/g)).toHaveLength(2);
    expect(classificationResultSource).toContain('if (!requestOwnsPendingModal(request)) return false');
    expect(saveSource).toContain('pendingClassification.requestId !== activeRequest.id');
    expect(saveSource).toContain('pendingClassification.cardIndex !== activeRequest.cardIndex');
  });

  it('clears and disables unresolved final-label controls while preserving request guards', () => {
    const draftSource = source.slice(
      source.indexOf('function updateObservationDraft'),
      source.indexOf('function requestOwnsPendingClassification')
    );

    expect(draftSource).toContain("if (status === 'unresolved')");
    expect(draftSource).toContain("finalLabelInput.value = ''");
    expect(draftSource).toContain('finalLabelInput.disabled = true');
    expect(draftSource).toContain("taxonomicLevelInput.value = 'unknown'");
    expect(draftSource).toContain('taxonomicLevelInput.disabled = true');
    expect(draftSource).toContain('finalLabelInput.disabled = false');
    expect(draftSource).toContain('taxonomicLevelInput.disabled = false');
    expect(draftSource).toContain('if (!activeRequest || !requestOwnsPendingModal(activeRequest)) return');
  });

  it('defends report labels against malformed unresolved records', () => {
    expect(reportSource).toContain("record.verificationStatus === 'unresolved'");
    expect(reportSource).toContain('ObservationRecord.UNRESOLVED_LABEL');
    expect(reportSource.indexOf("record.verificationStatus === 'unresolved'")).toBeLessThan(
      reportSource.indexOf("appendReportField(section, 'Label akhir', finalLabel)")
    );
  });

  it('uses matching browser and module length policies', () => {
    expect(source).toMatch(/id="final-label"[^>]*maxlength="120"/);
    expect(source).toMatch(/id="verification-evidence"[^>]*maxlength="1000"/);
    expect(ObservationRecord.LABEL_MAX_LENGTH).toBe(120);
    expect(ObservationRecord.EVIDENCE_MAX_LENGTH).toBe(1000);
    expect(source).toContain("errors.includes('final_label_too_long')");
    expect(source).toContain("errors.includes('verification_evidence_too_long')");
  });

  it('constructs observation report details with safe DOM text APIs', () => {
    expect(reportSource).toContain("document.createElement('section')");
    expect(reportSource).toContain('valueElement.textContent = value');
    expect(reportSource).not.toContain('innerHTML');
  });

  it('uses operational-category terminology in metrics and reports', () => {
    expect(source).toContain('Jumlah Kategori Operasional');
    expect(source).toContain('Distribusi Kategori');
    expect(source).not.toContain('Total Spesies');
    expect(source).not.toContain('Distribusi Spesies');
  });

  it('loads the observation module before biodiversity and application code', () => {
    const observationPosition = source.indexOf('<script src="src/utils/observationRecord.js"></script>');
    const biodiversityPosition = source.indexOf('<script src="src/utils/biodiversity.js"></script>');
    const applicationPosition = source.indexOf("document.addEventListener('DOMContentLoaded'");

    expect(observationPosition).toBeGreaterThan(-1);
    expect(observationPosition).toBeLessThan(biodiversityPosition);
    expect(biodiversityPosition).toBeLessThan(applicationPosition);
  });

  it('precaches the observation module under cache generation v17', () => {
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./src/utils/observationRecord.js'");
  });
});
