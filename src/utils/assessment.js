(function (root, factory) {
  const assessment = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = assessment;
    module.exports.default = assessment;
  } else {
    root.Assessment = assessment;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const NOT_MEASURED = 'Belum diukur';

  function createAssessmentState() {
    return {
      completed: false,
      responses: {},
      score: null,
      totalQuestions: 0,
      answeredQuestions: 0,
      correctAnswers: 0,
      error: null
    };
  }

  function normalizeResponse(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('id-ID');
  }

  function validateQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
      return { valid: false, error: 'empty_questions' };
    }

    const ids = new Set();
    for (const question of questions) {
      if (!question || typeof question.id !== 'string' || !question.id.trim() || ids.has(question.id)) {
        return { valid: false, error: 'invalid_question_id' };
      }
      if (typeof question.prompt !== 'string' || !question.prompt.trim()) {
        return { valid: false, error: 'invalid_question_prompt' };
      }
      if (!Array.isArray(question.acceptedAnswers) || question.acceptedAnswers.length === 0) {
        return { valid: false, error: 'invalid_answer_key' };
      }
      if (question.acceptedAnswers.some((answer) => !normalizeResponse(answer))) {
        return { valid: false, error: 'invalid_answer_key' };
      }
      ids.add(question.id);
    }

    return { valid: true, error: null };
  }

  function snapshotQuestions(questions) {
    const validation = validateQuestions(questions);
    if (!validation.valid) return null;
    return Object.freeze(questions.map((question) => Object.freeze({
      id: question.id,
      prompt: question.prompt,
      acceptedAnswers: Object.freeze([...question.acceptedAnswers])
    })));
  }

  function isResponseCorrect(question, response) {
    if (!question || !Array.isArray(question.acceptedAnswers)) return false;
    const normalizedResponse = normalizeResponse(response);
    if (!normalizedResponse) return false;
    return question.acceptedAnswers.some(
      (answer) => normalizeResponse(answer) === normalizedResponse
    );
  }

  function scoreAssessment(questions, responses) {
    const validation = validateQuestions(questions);
    if (!validation.valid) {
      return {
        responses: {}, score: null, totalQuestions: 0,
        answeredQuestions: 0, correctAnswers: 0, error: validation.error
      };
    }
    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
      return {
        responses: {}, score: null, totalQuestions: 0,
        answeredQuestions: 0, correctAnswers: 0, error: 'invalid_responses'
      };
    }

    let answeredQuestions = 0;
    let correctAnswers = 0;

    for (const question of questions) {
      const response = Object.prototype.hasOwnProperty.call(responses, question.id)
        ? responses[question.id]
        : '';
      if (normalizeResponse(response)) answeredQuestions += 1;
      if (isResponseCorrect(question, response)) correctAnswers += 1;
    }

    const totalQuestions = questions.length;

    return {
      responses: { ...responses },
      score: answeredQuestions === totalQuestions
        ? Math.round((correctAnswers / totalQuestions) * 100)
        : null,
      totalQuestions,
      answeredQuestions,
      correctAnswers,
      error: null
    };
  }

  function startAssessment(questions) {
    return { completed: false, ...scoreAssessment(questions, {}), score: null };
  }

  function recordAssessmentResponse(state, questions, questionId, value) {
    const previousResponses = state && state.responses && typeof state.responses === 'object'
      ? state.responses
      : {};
    if (!Array.isArray(questions) || !questions.some((question) => question.id === questionId)) {
      return {
        ...createAssessmentState(),
        responses: { ...previousResponses },
        error: 'unknown_question'
      };
    }

    const nextValue = String(value ?? '');
    if (previousResponses[questionId] === nextValue) {
      return { ...state, responses: { ...previousResponses } };
    }

    const responses = { ...previousResponses, [questionId]: nextValue };
    return { completed: false, ...scoreAssessment(questions, responses), score: null };
  }

  function submitAssessment(state, questions) {
    const responses = state && state.responses;
    const result = scoreAssessment(questions, responses);
    if (result.error) return { completed: false, ...result, score: null };
    if (result.score === null) {
      return { completed: false, ...result, score: null, error: 'incomplete_responses' };
    }
    return { completed: true, ...result, error: null };
  }

  function getCompletedScore(state) {
    if (!state || state.completed !== true || state.error) return null;
    if (!Number.isFinite(state.score) || state.score < 0 || state.score > 100) return null;
    if (!Number.isInteger(state.totalQuestions) || state.totalQuestions <= 0) return null;
    if (state.answeredQuestions !== state.totalQuestions) return null;
    return state.score;
  }

  function summarizeAssessments(preAssessment, postAssessment) {
    const preScore = getCompletedScore(preAssessment);
    const postScore = getCompletedScore(postAssessment);
    return {
      preScore,
      postScore,
      difference: preScore === null || postScore === null ? null : postScore - preScore
    };
  }

  function formatScore(score) {
    return Number.isFinite(score) ? `${score}%` : NOT_MEASURED;
  }

  function formatPercentagePointDifference(difference) {
    return Number.isFinite(difference) ? `${difference} poin persentase` : NOT_MEASURED;
  }

  return {
    NOT_MEASURED,
    createAssessmentState,
    formatPercentagePointDifference,
    formatScore,
    getCompletedScore,
    isResponseCorrect,
    normalizeResponse,
    recordAssessmentResponse,
    scoreAssessment,
    snapshotQuestions,
    startAssessment,
    submitAssessment,
    summarizeAssessments,
    validateQuestions
  };
});
