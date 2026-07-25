(function (root, factory) {
  const observationRecord = typeof module === 'object' && module.exports
    ? require('./observationRecord.js')
    : root.ObservationRecord;
  const biodiversity = factory(observationRecord);

  if (typeof module === 'object' && module.exports) {
    module.exports = biodiversity;
    module.exports.default = biodiversity;
  } else {
    root.Biodiversity = biodiversity;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ObservationRecord) {
  const EXCLUSION_REASONS = Object.freeze({
    INVALID_OBSERVATIONS: 'invalid_observations',
    MISSING_RECORD: 'missing_record',
    INVALID_RECORD: 'invalid_record',
    INVALID_RECORD_ID: 'invalid_record_id',
    INVALID_FINAL_LABEL: 'invalid_final_label',
    FINAL_LABEL_TOO_LONG: 'final_label_too_long',
    UNRESOLVED_IDENTIFICATION: 'unresolved_identification',
    INVALID_VERIFICATION_STATUS: 'invalid_verification_status',
    INVALID_TAXONOMIC_LEVEL: 'invalid_taxonomic_level',
    INVALID_RECORD_SOURCE: 'invalid_record_source',
    MISSING_VERIFICATION_EVIDENCE: 'missing_verification_evidence',
    VERIFICATION_EVIDENCE_TOO_LONG: 'verification_evidence_too_long',
    MISSING_COUNT: 'missing_count',
    NON_NUMERIC_COUNT: 'non_numeric_count',
    NON_FINITE_COUNT: 'non_finite_count',
    NON_POSITIVE_COUNT: 'non_positive_count',
    FRACTIONAL_COUNT: 'fractional_count',
    COUNT_ABOVE_MAXIMUM: 'count_above_maximum'
  });
  const MAX_COUNT = 999;

  function exclusion(index, record, reason) {
    return { index, record, reason };
  }

  function countExclusionReason(record) {
    if (!Object.prototype.hasOwnProperty.call(record, 'count') || record.count === undefined) {
      return EXCLUSION_REASONS.MISSING_COUNT;
    }
    if (typeof record.count !== 'number') {
      return EXCLUSION_REASONS.NON_NUMERIC_COUNT;
    }
    if (!Number.isFinite(record.count)) {
      return EXCLUSION_REASONS.NON_FINITE_COUNT;
    }
    if (record.count <= 0) {
      return EXCLUSION_REASONS.NON_POSITIVE_COUNT;
    }
    if (!Number.isInteger(record.count)) {
      return EXCLUSION_REASONS.FRACTIONAL_COUNT;
    }
    if (record.count > MAX_COUNT) {
      return EXCLUSION_REASONS.COUNT_ABOVE_MAXIMUM;
    }
    return null;
  }

  function buildAnalysis(observations) {
    if (!Array.isArray(observations)) {
      return {
        includedRecords: [],
        excludedRecords: [],
        categoryCounts: {},
        totalCategories: 0,
        totalIndividuals: 0,
        shannonIndex: 0,
        warnings: [{ index: null, reason: EXCLUSION_REASONS.INVALID_OBSERVATIONS }]
      };
    }

    const includedRecords = [];
    const excludedRecords = [];
    const categoryCountEntries = new Map();

    for (let index = 0; index < observations.length; index += 1) {
      const record = observations[index];
      if (record === null || record === undefined) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.MISSING_RECORD));
        continue;
      }
      if (typeof record !== 'object' || Array.isArray(record)) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.INVALID_RECORD));
        continue;
      }
      if (typeof record.id !== 'number' || !Number.isInteger(record.id) || record.id < 0) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.INVALID_RECORD_ID));
        continue;
      }
      if (record.verificationStatus === 'unresolved') {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.UNRESOLVED_IDENTIFICATION));
        continue;
      }

      const category = ObservationRecord
        ? ObservationRecord.canonicalizeLabel(record.finalLabel)
        : (typeof record.finalLabel === 'string' ? record.finalLabel.trim() : '');
      if (!category) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.INVALID_FINAL_LABEL));
        continue;
      }
      if (ObservationRecord && category.length > ObservationRecord.LABEL_MAX_LENGTH) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.FINAL_LABEL_TOO_LONG));
        continue;
      }
      if (!['unverified', 'probable', 'verified'].includes(record.verificationStatus)) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.INVALID_VERIFICATION_STATUS));
        continue;
      }
      if (!['species', 'genus', 'family', 'broad_category'].includes(record.taxonomicLevel)) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.INVALID_TAXONOMIC_LEVEL));
        continue;
      }
      if (!['user', 'sample'].includes(record.recordSource)) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.INVALID_RECORD_SOURCE));
        continue;
      }
      if ((record.verificationStatus === 'probable' || record.verificationStatus === 'verified')
        && !(ObservationRecord
          ? ObservationRecord.canonicalizeEvidence(record.verificationEvidence)
          : String(record.verificationEvidence || '').trim())) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.MISSING_VERIFICATION_EVIDENCE));
        continue;
      }
      if (ObservationRecord
        && ObservationRecord.canonicalizeEvidence(record.verificationEvidence).length
          > ObservationRecord.EVIDENCE_MAX_LENGTH) {
        excludedRecords.push(exclusion(index, record, EXCLUSION_REASONS.VERIFICATION_EVIDENCE_TOO_LONG));
        continue;
      }

      const countReason = countExclusionReason(record);
      if (countReason) {
        excludedRecords.push(exclusion(index, record, countReason));
        continue;
      }

      includedRecords.push(record);
      categoryCountEntries.set(category, (categoryCountEntries.get(category) || 0) + record.count);
    }

    const categoryCounts = Object.fromEntries(categoryCountEntries);
    const totalIndividuals = Object.values(categoryCounts)
      .reduce((total, count) => total + count, 0);
    let shannonIndex = 0;
    if (totalIndividuals > 0) {
      for (const count of Object.values(categoryCounts)) {
        const proportion = count / totalIndividuals;
        shannonIndex -= proportion * Math.log(proportion);
      }
    }

    return {
      includedRecords,
      excludedRecords,
      categoryCounts,
      totalCategories: Object.keys(categoryCounts).length,
      totalIndividuals,
      shannonIndex,
      warnings: excludedRecords.map(({ index, reason }) => ({ index, reason }))
    };
  }

  return {
    EXCLUSION_REASONS,
    MAX_COUNT,
    buildAnalysis
  };
});
