(function (root, factory) {
  const diversityInterpretation = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = diversityInterpretation;
    module.exports.default = diversityInterpretation;
  } else if (root) {
    root.DiversityInterpretation = diversityInterpretation;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EXCLUSION_REASON_LABELS = Object.freeze({
    invalid_observations: 'Data observasi tidak valid',
    missing_record: 'Observasi kosong',
    invalid_record: 'Data observasi tidak valid',
    unresolved_identification: 'Belum teridentifikasi',
    invalid_record_id: 'ID observasi tidak valid',
    invalid_final_label: 'Label akhir tidak valid',
    final_label_too_long: 'Label akhir terlalu panjang',
    invalid_verification_status: 'Status verifikasi tidak valid',
    invalid_taxonomic_level: 'Tingkat identifikasi tidak valid',
    invalid_record_source: 'Sumber rekaman tidak valid',
    missing_verification_evidence: 'Bukti verifikasi belum dicatat',
    verification_evidence_too_long: 'Bukti verifikasi terlalu panjang',
    missing_count: 'Jumlah individu belum diisi',
    non_numeric_count: 'Jumlah individu bukan angka',
    non_finite_count: 'Jumlah individu tidak valid',
    non_positive_count: 'Jumlah individu harus lebih dari nol',
    fractional_count: 'Jumlah individu harus bilangan bulat',
    count_above_maximum: 'Jumlah individu melebihi batas 999'
  });

  const OPERATIONAL_CATEGORY_NOTE = 'Kategori operasional dapat mencakup label luas, belum diverifikasi, atau hasil keputusan pembelajar dan tidak otomatis setara dengan spesies.';
  const COMPARISON_NOTE = 'Perbandingan H′ antar-survei hanya bermakna bila metode, area, waktu, durasi, upaya sampling, dan aturan kategorisasi cukup sebanding. Aplikasi ini belum mencatat protokol sampling lengkap untuk memastikan kesebandingan tersebut.';
  const SAMPLE_NOTE = 'Data ini adalah data contoh untuk demonstrasi, bukan hasil survei lapangan.';
  const MIXED_SOURCE_NOTE = 'Data ini mencampurkan data contoh dan observasi pengguna, sehingga tidak boleh ditafsirkan sebagai satu sampel lapangan yang koheren.';
  const PARTIAL_SOURCE_NOTE = 'Sumber sebagian observasi tidak dicatat atau tidak valid, sehingga komposisi sumber data tidak dapat dipastikan sepenuhnya.';
  const UNKNOWN_EXCLUSION_LABEL = 'Data observasi tidak valid';

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function formatExclusionReason(reason) {
    return EXCLUSION_REASON_LABELS[reason] || UNKNOWN_EXCLUSION_LABEL;
  }

  function summarizeExclusions(analysis) {
    const exclusions = asArray(analysis && analysis.excludedRecords);
    const counts = Object.create(null);

    exclusions.forEach((entry) => {
      const reason = entry && typeof entry.reason === 'string' ? entry.reason : 'invalid_record';
      counts[reason] = (counts[reason] || 0) + 1;
    });

    const exclusionCounts = Object.fromEntries(
      Object.keys(counts).sort().map((reason) => [reason, counts[reason]])
    );
    const entries = Object.keys(exclusionCounts).map((reason) => ({
      reason,
      label: formatExclusionReason(reason),
      count: exclusionCounts[reason]
    }));
    const unresolvedRecordCount = exclusionCounts.unresolved_identification || 0;
    const excludedRecordCount = exclusions.length;

    return {
      excludedRecordCount,
      unresolvedRecordCount,
      invalidRecordCount: excludedRecordCount - unresolvedRecordCount,
      exclusionCounts,
      entries,
      summary: excludedRecordCount === 0
        ? 'Tidak ada observasi yang dikecualikan dari perhitungan.'
        : `${excludedRecordCount} observasi dikecualikan dari perhitungan: ${entries.map((entry) => `${entry.label} (${entry.count})`).join(', ')}.`
    };
  }

  function observationObjects(analysis, observations) {
    if (Array.isArray(observations)) {
      return observations.filter((record) => record && typeof record === 'object' && !Array.isArray(record));
    }

    return [
      ...asArray(analysis && analysis.includedRecords),
      ...asArray(analysis && analysis.excludedRecords).map((entry) => entry && entry.record)
    ].filter((record) => record && typeof record === 'object' && !Array.isArray(record));
  }

  function describeSource(records) {
    const sources = new Set();
    let unknownSourceCount = 0;

    records.forEach((record) => {
      if (record.recordSource === 'sample' || record.recordSource === 'user') {
        sources.add(record.recordSource);
      } else {
        unknownSourceCount += 1;
      }
    });

    const hasSample = sources.has('sample');
    const hasUser = sources.has('user');
    if (hasSample && hasUser) {
      return { state: 'mixed', note: MIXED_SOURCE_NOTE, unknownSourceCount };
    }
    if (unknownSourceCount > 0) {
      return { state: 'partially_unknown', note: PARTIAL_SOURCE_NOTE, unknownSourceCount };
    }
    if (hasSample) return { state: 'sample_only', note: SAMPLE_NOTE, unknownSourceCount };
    if (hasUser) return { state: 'user_only', note: '', unknownSourceCount };
    return { state: 'none', note: '', unknownSourceCount };
  }

  function buildSamplingLimitations() {
    return {
      operationalCategoryNote: OPERATIONAL_CATEGORY_NOTE,
      comparisonNote: COMPARISON_NOTE
    };
  }

  function noDataSummary(exclusions) {
    if (exclusions.excludedRecordCount === 0) {
      return 'Belum ada observasi yang dicatat.';
    }
    if (exclusions.unresolvedRecordCount > 0 && exclusions.invalidRecordCount === 0) {
      return 'Observasi yang dicatat masih belum teridentifikasi dan belum dapat dimasukkan ke dalam analisis Shannon.';
    }
    if (exclusions.unresolvedRecordCount === 0) {
      return 'Observasi yang dicatat dikecualikan dari analisis Shannon karena data tidak valid.';
    }
    return 'Observasi yang dicatat mencakup data belum teridentifikasi dan data tidak valid, sehingga belum ada data valid yang dapat dimasukkan ke dalam analisis Shannon.';
  }

  function describeAnalysis(analysis, observations) {
    const includedRecords = asArray(analysis && analysis.includedRecords);
    const records = observationObjects(analysis, observations);
    const totalCategories = asNonNegativeInteger(analysis && analysis.totalCategories);
    const totalIndividuals = Number.isFinite(analysis && analysis.totalIndividuals) && analysis.totalIndividuals >= 0
      ? analysis.totalIndividuals
      : 0;
    const shannonIndex = Number.isFinite(analysis && analysis.shannonIndex) && analysis.shannonIndex >= 0
      ? analysis.shannonIndex
      : 0;
    const exclusions = summarizeExclusions(analysis);
    const source = describeSource(records);
    const limitations = buildSamplingLimitations();
    let state;
    let summary;

    if (includedRecords.length === 0) {
      state = 'no_valid_data';
      summary = noDataSummary(exclusions);
    } else if (totalCategories === 1) {
      state = 'single_category';
      summary = 'H′ = 0 karena seluruh individu valid dalam sampel ini tercatat pada satu kategori operasional. Nilai ini tidak membuktikan bahwa lokasi tidak memiliki keanekaragaman hayati lain yang belum diamati atau belum teridentifikasi.';
    } else {
      state = 'multiple_categories';
      summary = 'Pada sampel ini, H′ merangkum jumlah kategori operasional dan pemerataan jumlah individu di antara kategori yang disertakan.';
    }

    return {
      state,
      summary,
      methodologicalNote: limitations.operationalCategoryNote,
      comparisonNote: limitations.comparisonNote,
      sourceState: source.state,
      sourceNote: source.note,
      unknownSourceCount: source.unknownSourceCount,
      includedRecordCount: includedRecords.length,
      excludedRecordCount: exclusions.excludedRecordCount,
      unresolvedRecordCount: exclusions.unresolvedRecordCount,
      invalidRecordCount: exclusions.invalidRecordCount,
      totalRecordedObservationCount: includedRecords.length + exclusions.excludedRecordCount,
      totalCategories,
      totalIndividuals,
      shannonIndex,
      exclusionCounts: exclusions.exclusionCounts,
      exclusionEntries: exclusions.entries,
      exclusionSummary: exclusions.summary,
      cautions: [limitations.operationalCategoryNote, limitations.comparisonNote, source.note].filter(Boolean)
    };
  }

  return {
    EXCLUSION_REASON_LABELS,
    UNKNOWN_EXCLUSION_LABEL,
    formatExclusionReason,
    summarizeExclusions,
    buildSamplingLimitations,
    describeAnalysis
  };
});
