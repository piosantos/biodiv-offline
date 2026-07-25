(function (root, factory) {
    const observationRecord = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = observationRecord;
        module.exports.default = observationRecord;
    } else if (root) {
        root.ObservationRecord = observationRecord;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const LABEL_MAX_LENGTH = 120;
    const EVIDENCE_MAX_LENGTH = 1000;
    const TAXONOMIC_LEVELS = Object.freeze([
        'species',
        'genus',
        'family',
        'broad_category',
        'unknown'
    ]);
    const VERIFICATION_STATUSES = Object.freeze([
        'unverified',
        'probable',
        'verified',
        'unresolved'
    ]);
    const RECORD_SOURCES = Object.freeze(['user', 'sample']);

    const TAXONOMIC_LEVEL_LABELS = Object.freeze({
        species: 'Spesies',
        genus: 'Genus',
        family: 'Famili',
        broad_category: 'Kategori luas',
        unknown: 'Tidak diketahui'
    });
    const VERIFICATION_STATUS_LABELS = Object.freeze({
        unverified: 'Belum diverifikasi',
        probable: 'Kemungkinan',
        verified: 'Terverifikasi',
        unresolved: 'Belum teridentifikasi'
    });
    const RECORD_SOURCE_LABELS = Object.freeze({
        user: 'Pengguna',
        sample: 'Data contoh'
    });

    function normalizeLineEndings(value) {
        return value.replace(/\r\n?/g, '\n');
    }

    function removeUnsupportedControls(value) {
        return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
    }

    function canonicalizeLabel(value) {
        if (value === null || value === undefined) return '';

        return removeUnsupportedControls(normalizeLineEndings(String(value)))
            .replace(/[\n\t]+/g, ' ')
            .trim();
    }

    function canonicalizeEvidence(value) {
        if (value === null || value === undefined) return '';

        return removeUnsupportedControls(normalizeLineEndings(String(value)))
            .trim();
    }

    function normalizeModelCandidate(candidate) {
        if (!candidate || typeof candidate !== 'object') return null;

        const rawClassName = canonicalizeLabel(candidate.rawClassName);
        const suggestedLabel = canonicalizeLabel(candidate.suggestedLabel);
        if (!rawClassName || !suggestedLabel) return null;

        const score = typeof candidate.score === 'number'
            && Number.isFinite(candidate.score)
            && candidate.score >= 0
            && candidate.score <= 1
            ? candidate.score
            : null;

        return {
            rawClassName,
            suggestedLabel,
            score
        };
    }

    function countValidationReason(count) {
        if (count === '' || count === null || count === undefined) return 'missing_count';
        if (typeof count !== 'number' || !Number.isFinite(count)) return 'non_numeric_count';
        if (!Number.isInteger(count)) return 'fractional_count';
        if (count <= 0) return count === 0 ? 'zero_count' : 'negative_count';
        if (count > 999) return 'count_above_maximum';
        return null;
    }

    function isValidCount(count) {
        return countValidationReason(count) === null;
    }

    function validateObservationDraft(input) {
        const source = input && typeof input === 'object' ? input : {};
        const verificationStatus = source.verificationStatus;
        const requestedLevel = source.taxonomicLevel;
        const taxonomicLevel = verificationStatus === 'unresolved' ? 'unknown' : requestedLevel;
        const finalLabel = canonicalizeLabel(source.finalLabel);
        const verificationEvidence = canonicalizeEvidence(source.verificationEvidence);
        const recordSource = source.recordSource;
        const errors = [];

        if (typeof source.id !== 'number' || !Number.isInteger(source.id) || source.id < 0) {
            errors.push('invalid_record_id');
        }
        if (!VERIFICATION_STATUSES.includes(verificationStatus)) {
            errors.push('invalid_verification_status');
        }
        if (!TAXONOMIC_LEVELS.includes(taxonomicLevel)) {
            errors.push('invalid_taxonomic_level');
        }
        if (!RECORD_SOURCES.includes(recordSource)) {
            errors.push('invalid_record_source');
        }

        if (verificationStatus === 'unresolved' && finalLabel) {
            errors.push('unresolved_final_label_present');
        }
        if (verificationStatus !== 'unresolved') {
            if (!finalLabel) errors.push('missing_final_label');
            if (taxonomicLevel === 'unknown') errors.push('unknown_taxonomic_level');
        }
        if (finalLabel.length > LABEL_MAX_LENGTH) {
            errors.push('final_label_too_long');
        }

        if ((verificationStatus === 'probable' || verificationStatus === 'verified') && !verificationEvidence) {
            errors.push('missing_verification_evidence');
        }
        if (verificationEvidence.length > EVIDENCE_MAX_LENGTH) {
            errors.push('verification_evidence_too_long');
        }

        const countError = countValidationReason(source.count);
        if (countError) errors.push(countError);

        return {
            valid: errors.length === 0,
            errors,
            draft: {
                finalLabel,
                taxonomicLevel,
                verificationStatus,
                verificationEvidence,
                count: source.count,
                recordSource,
                modelCandidate: normalizeModelCandidate(source.modelCandidate)
            }
        };
    }

    function createObservationRecord(input) {
        const source = input && typeof input === 'object' ? input : {};
        const validation = validateObservationDraft(source);
        if (!validation.valid) {
            return { record: null, errors: validation.errors };
        }

        return {
            record: {
                id: source.id,
                imgSrc: typeof source.imgSrc === 'string' ? source.imgSrc : '',
                modelCandidate: validation.draft.modelCandidate,
                finalLabel: validation.draft.finalLabel,
                taxonomicLevel: validation.draft.taxonomicLevel,
                verificationStatus: validation.draft.verificationStatus,
                verificationEvidence: validation.draft.verificationEvidence,
                count: validation.draft.count,
                recordSource: validation.draft.recordSource
            },
            errors: []
        };
    }

    function isAnalysisEligible(record) {
        if (!record || record.verificationStatus === 'unresolved') return false;
        return validateObservationDraft(record).valid;
    }

    function formatTaxonomicLevel(value) {
        return TAXONOMIC_LEVEL_LABELS[value] || TAXONOMIC_LEVEL_LABELS.unknown;
    }

    function formatVerificationStatus(value) {
        return VERIFICATION_STATUS_LABELS[value] || 'Status tidak valid';
    }

    function formatRecordSource(value) {
        return RECORD_SOURCE_LABELS[value] || 'Sumber tidak valid';
    }

    return {
        LABEL_MAX_LENGTH,
        EVIDENCE_MAX_LENGTH,
        TAXONOMIC_LEVELS,
        VERIFICATION_STATUSES,
        RECORD_SOURCES,
        UNRESOLVED_LABEL: 'Belum teridentifikasi',
        canonicalizeLabel,
        canonicalizeEvidence,
        normalizeModelCandidate,
        countValidationReason,
        isValidCount,
        validateObservationDraft,
        createObservationRecord,
        isAnalysisEligible,
        formatTaxonomicLevel,
        formatVerificationStatus,
        formatRecordSource
    };
});
