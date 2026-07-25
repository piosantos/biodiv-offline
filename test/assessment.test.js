import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Assessment from '../src/utils/assessment.js';

const questions = [
  { id: 'q1', prompt: 'Pertanyaan satu?', acceptedAnswers: ['Benar'] },
  { id: 'q2', prompt: 'Pertanyaan dua?', acceptedAnswers: ['Ya'] }
];

const fiveQuestions = Array.from({ length: 5 }, (_, index) => ({
  id: `q${index + 1}`,
  prompt: `Pertanyaan ${index + 1}?`,
  acceptedAnswers: ['Benar']
}));

function enterAnswers(answers, questionSet = questions) {
  return Object.entries(answers).reduce(
    (state, [questionId, value]) => Assessment.recordAssessmentResponse(
      state,
      questionSet,
      questionId,
      value
    ),
    Assessment.startAssessment(questionSet)
  );
}

function answerAll(answers, questionSet = questions) {
  return Assessment.submitAssessment(enterAnswers(answers, questionSet), questionSet);
}

function answerFive(correctAnswers) {
  const responses = Object.fromEntries(fiveQuestions.map((question, index) => [
    question.id,
    index < correctAnswers ? 'Benar' : 'Salah'
  ]));
  return answerAll(responses, fiveQuestions);
}

describe('assessment reporting', () => {
  it('shows Belum diukur when pre and post assessments are missing', () => {
    const summary = Assessment.summarizeAssessments(
      Assessment.createAssessmentState(),
      Assessment.createAssessmentState()
    );

    expect(Assessment.formatScore(summary.preScore)).toBe('Belum diukur');
    expect(Assessment.formatScore(summary.postScore)).toBe('Belum diukur');
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('Belum diukur');
  });

  it('does not report a difference with a missing pre-assessment', () => {
    const summary = Assessment.summarizeAssessments(
      Assessment.createAssessmentState(),
      answerAll({ q1: 'Benar', q2: 'Ya' })
    );

    expect(summary.postScore).toBe(100);
    expect(summary.difference).toBeNull();
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('Belum diukur');
  });

  it('does not report a difference with a missing post-assessment', () => {
    const summary = Assessment.summarizeAssessments(
      answerAll({ q1: 'Benar', q2: 'Ya' }),
      Assessment.createAssessmentState()
    );

    expect(summary.preScore).toBe(100);
    expect(summary.difference).toBeNull();
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('Belum diukur');
  });

  it('preserves a completed score of zero as valid', () => {
    const state = answerAll({ q1: 'Salah', q2: 'Tidak' });

    expect(state.completed).toBe(true);
    expect(state.score).toBe(0);
    expect(Assessment.getCompletedScore(state)).toBe(0);
    expect(Assessment.formatScore(state.score)).toBe('0%');
  });

  it('renders a zero pre-score without fabricating post or difference values', () => {
    const summary = Assessment.summarizeAssessments(
      answerAll({ q1: 'Salah', q2: 'Tidak' }),
      Assessment.createAssessmentState()
    );

    expect(Assessment.formatScore(summary.preScore)).toBe('0%');
    expect(Assessment.formatScore(summary.postScore)).toBe('Belum diukur');
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('Belum diukur');
  });

  it('renders a zero post-score without fabricating pre or difference values', () => {
    const summary = Assessment.summarizeAssessments(
      Assessment.createAssessmentState(),
      answerAll({ q1: 'Salah', q2: 'Tidak' })
    );

    expect(Assessment.formatScore(summary.preScore)).toBe('Belum diukur');
    expect(Assessment.formatScore(summary.postScore)).toBe('0%');
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('Belum diukur');
  });

  it('reports the raw percentage-point difference for a valid pair', () => {
    const summary = Assessment.summarizeAssessments(
      answerFive(1),
      answerFive(5)
    );

    expect(summary).toEqual({ preScore: 20, postScore: 100, difference: 80 });
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('80 poin persentase');
  });

  it('keeps a negative percentage-point difference instead of clamping it', () => {
    const summary = Assessment.summarizeAssessments(
      answerFive(4),
      answerFive(3)
    );

    expect(summary.difference).toBe(-20);
    expect(Assessment.formatPercentagePointDifference(summary.difference)).toBe('-20 poin persentase');
  });
});

describe('explicit assessment completion', () => {
  it('keeps all answered fields incomplete and unscored before submission', () => {
    const draft = enterAnswers({ q1: 'Benar', q2: 'Ya' });

    expect(draft).toMatchObject({
      completed: false,
      score: null,
      answeredQuestions: 2,
      correctAnswers: 2,
      error: null
    });
  });

  it('rejects submission safely while a required response is missing', () => {
    const draft = enterAnswers({ q1: 'Benar' });
    const submitted = Assessment.submitAssessment(draft, questions);

    expect(submitted).toMatchObject({
      completed: false,
      score: null,
      answeredQuestions: 1,
      error: 'incomplete_responses'
    });
  });

  it('completes a valid submission with a deterministic score', () => {
    const submitted = answerAll({ q1: 'Benar', q2: 'Tidak' });

    expect(submitted).toMatchObject({ completed: true, score: 50, correctAnswers: 1, error: null });
  });

  it('invalidates a completed score when a response is edited', () => {
    const completed = answerAll({ q1: 'Benar', q2: 'Ya' });
    const edited = Assessment.recordAssessmentResponse(completed, questions, 'q1', 'Salah');

    expect(edited).toMatchObject({ completed: false, score: null, correctAnswers: 1, error: null });
  });

  it('recalculates the result only after explicit resubmission', () => {
    const completed = answerAll({ q1: 'Salah', q2: 'Ya' });
    const edited = Assessment.recordAssessmentResponse(completed, questions, 'q1', 'Benar');
    const resubmitted = Assessment.submitAssessment(edited, questions);

    expect(edited.score).toBeNull();
    expect(resubmitted).toMatchObject({ completed: true, score: 100, correctAnswers: 2 });
  });

  it('returns an identical score on repeated submission without changes', () => {
    const first = answerAll({ q1: 'Benar', q2: 'Ya' });
    const second = Assessment.submitAssessment(first, questions);

    expect(second).toEqual(first);
  });

  it('completes an explicitly submitted zero score', () => {
    const submitted = answerAll({ q1: 'Salah', q2: 'Tidak' });

    expect(submitted).toMatchObject({ completed: true, score: 0, correctAnswers: 0 });
  });
});

describe('deterministic assessment scoring', () => {
  it('returns the same result for repeated scoring calls', () => {
    const responses = { q1: 'Benar', q2: 'Tidak' };

    expect(Assessment.scoreAssessment(questions, responses)).toEqual(
      Assessment.scoreAssessment(questions, responses)
    );
    expect(responses).toEqual({ q1: 'Benar', q2: 'Tidak' });
  });

  it('cannot inflate a score when input, change, and blur record the same response', () => {
    const oneQuestion = [questions[0]];
    let state = Assessment.startAssessment(oneQuestion);

    state = Assessment.recordAssessmentResponse(state, oneQuestion, 'q1', 'Benar');
    state = Assessment.recordAssessmentResponse(state, oneQuestion, 'q1', 'Benar');
    state = Assessment.recordAssessmentResponse(state, oneQuestion, 'q1', 'Benar');

    expect(state.completed).toBe(false);
    expect(state.score).toBeNull();
    expect(state.correctAnswers).toBe(1);
    expect(state.responses).toEqual({ q1: 'Benar' });

    state = Assessment.submitAssessment(state, oneQuestion);
    state = Assessment.recordAssessmentResponse(state, oneQuestion, 'q1', 'Benar');
    expect(state.score).toBe(100);
    expect(state.completed).toBe(true);
  });

  it('recalculates the score when a response is revised', () => {
    const oneQuestion = [questions[0]];
    let state = Assessment.startAssessment(oneQuestion);
    state = Assessment.recordAssessmentResponse(state, oneQuestion, 'q1', 'Salah');
    state = Assessment.submitAssessment(state, oneQuestion);
    expect(state.score).toBe(0);

    state = Assessment.recordAssessmentResponse(state, oneQuestion, 'q1', 'Benar');
    expect(state.score).toBeNull();
    expect(state.correctAnswers).toBe(1);
    state = Assessment.submitAssessment(state, oneQuestion);
    expect(state.score).toBe(100);
  });

  it('retains a wrong learner response instead of replacing it with the answer key', () => {
    const state = Assessment.recordAssessmentResponse(
      Assessment.startAssessment([questions[0]]),
      [questions[0]],
      'q1',
      'Jawaban saya'
    );

    expect(state.responses.q1).toBe('Jawaban saya');
    expect(state.responses.q1).not.toContain('Benar');
    expect(state.score).toBeNull();
  });

  it('keeps pre and post sessions independent', () => {
    const pre = answerAll({ q1: 'Benar', q2: 'Ya' });
    const post = answerAll({ q1: 'Salah', q2: 'Tidak' });

    expect(pre.score).toBe(100);
    expect(post.score).toBe(0);
    expect(pre.responses).not.toBe(post.responses);
    expect(pre.responses).toEqual({ q1: 'Benar', q2: 'Ya' });
  });

  it('starts regenerated or reopened sessions without stale responses or scores', () => {
    const completed = answerAll({ q1: 'Benar', q2: 'Ya' });
    const regenerated = Assessment.startAssessment(questions);

    expect(completed.score).toBe(100);
    expect(regenerated).toMatchObject({
      completed: false,
      responses: {},
      score: null,
      totalQuestions: 2,
      answeredQuestions: 0,
      correctAnswers: 0
    });
  });

  it('fails safely for empty question sets and incomplete responses', () => {
    const empty = Assessment.scoreAssessment([], {});
    const incomplete = Assessment.scoreAssessment(questions, { q1: 'Benar' });

    expect(empty).toMatchObject({ score: null, error: 'empty_questions' });
    expect(incomplete).toMatchObject({
      score: null,
      totalQuestions: 2,
      answeredQuestions: 1,
      error: null
    });
  });

  it('fails safely when question or response state is invalid', () => {
    const duplicateIds = [questions[0], { ...questions[1], id: 'q1' }];

    expect(Assessment.scoreAssessment(duplicateIds, {}).error).toBe('invalid_question_id');
    expect(Assessment.scoreAssessment(questions, null).error).toBe('invalid_responses');
  });

  it('normalizes case and surrounding whitespace deterministically', () => {
    expect(Assessment.isResponseCorrect(questions[0], '  bENar  ')).toBe(true);
    expect(Assessment.normalizeResponse('  BENAR   SEKALI ')).toBe('benar sekali');
  });

  it('does not accept contradictory or empty text as an exact answer', () => {
    expect(Assessment.isResponseCorrect(questions[0], 'tidak benar')).toBe(false);
    expect(Assessment.isResponseCorrect(questions[0], '')).toBe(false);
    expect(Assessment.isResponseCorrect(questions[0], '   ')).toBe(false);
  });

  it('freezes a defensive question snapshot for each session', () => {
    const sourceQuestions = [{ id: 'q1', prompt: 'Asli?', acceptedAnswers: ['Benar'] }];
    const snapshot = Assessment.snapshotQuestions(sourceQuestions);
    sourceQuestions[0].prompt = 'Diubah?';
    sourceQuestions[0].acceptedAnswers[0] = 'Salah';

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].acceptedAnswers)).toBe(true);
    expect(snapshot[0]).toEqual({ id: 'q1', prompt: 'Asli?', acceptedAnswers: ['Benar'] });
  });
});

describe('assessment UI source integrity', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const serviceWorkerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');

  it('contains no retained simulated assessment or synthetic multiplier', () => {
    expect(source).not.toMatch(/simulasi/i);
    expect(source).not.toContain('1.18');
    expect(source).not.toMatch(/preQuizScore|postQuizScore|correctCount/);
    expect(source).not.toMatch(/localStorage\.(?:getItem|setItem)\(['"](?:preScore|postScore)/);
  });

  it('labels report subtraction as a percentage-point difference', () => {
    expect(source).toContain('<strong>Selisih poin persentase:</strong>');
    expect(source).not.toContain('Pre-Post Gain');
  });

  it('requires an explicit scoring action in every rendered assessment', () => {
    expect(source).toContain("submitButton.textContent = 'Nilai Jawaban'");
    expect(source).toContain('Assessment.submitAssessment');
  });

  it('uses bounded Shannon and ecosystem-quality question content for the shared pre/post set', () => {
    expect(source).toContain("Dalam sampel dengan metode yang sebanding, apa yang dirangkum oleh indeks Shannon (H')?");
    expect(source).toContain("'Jumlah kategori dan pemerataan individu'");
    expect(source).toContain("'Kekayaan kategori dan pemerataan individu'");
    expect(source).toContain("Apakah H' saja cukup untuk membuktikan kualitas suatu ekosistem?");
    expect(source).toContain("acceptedAnswers: ['Tidak']");
    expect(source).not.toContain("Apa arti nilai indeks Shannon (H') yang lebih tinggi?");
    expect(source).toContain("startAssessmentSession('pre', measuredAssessmentQuestions)");
    expect(source).toContain("startAssessmentSession('post', measuredAssessmentQuestions)");
  });

  it('precaches the assessment module under a bumped cache generation', () => {
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./src/utils/assessment.js'");
  });
});
