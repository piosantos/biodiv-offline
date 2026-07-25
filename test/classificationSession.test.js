import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ClassificationSession from '../src/utils/classificationSession.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function acceptActiveResult(controller, request, work, acceptedResults) {
  try {
    const value = await work;
    if (!controller.isActive(request.id)) return { status: 'stale' };
    acceptedResults.push({ requestId: request.id, value });
    return { status: 'accepted', value };
  } catch (error) {
    return {
      status: controller.isActive(request.id) ? 'current_error' : 'stale_error',
      error
    };
  }
}

describe('classification request lifecycle', () => {
  it('assigns an ID to the first valid request', () => {
    const controller = ClassificationSession.createController();

    expect(controller.begin({ cardIndex: 0, fileName: 'first.jpg' })).toEqual({
      id: 1,
      cardIndex: 0,
      fileName: 'first.jpg'
    });
  });

  it('assigns unique monotonically increasing IDs', () => {
    const controller = ClassificationSession.createController();
    const first = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });
    const second = controller.begin({ cardIndex: 1, fileName: 'second.jpg' });
    const third = controller.begin({ cardIndex: 2, fileName: 'third.jpg' });

    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
  });

  it('invalidates the previous request when a new request begins', () => {
    const controller = ClassificationSession.createController();
    const first = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });
    const second = controller.begin({ cardIndex: 1, fileName: 'second.jpg' });

    expect(controller.isActive(first.id)).toBe(false);
    expect(controller.getActive()).toEqual(second);
  });

  it('recognizes only the current request as active', () => {
    const controller = ClassificationSession.createController();
    const first = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });
    const second = controller.begin({ cardIndex: 1, fileName: 'second.jpg' });

    expect(controller.isActive(first.id)).toBe(false);
    expect(controller.isActive(second.id)).toBe(true);
    expect(controller.isActive(999)).toBe(false);
  });

  it('completes and clears the current request', () => {
    const controller = ClassificationSession.createController();
    const request = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });

    expect(controller.complete(request.id)).toBe(true);
    expect(controller.getActive()).toBeNull();
  });

  it('does not let stale completion clear the current request', () => {
    const controller = ClassificationSession.createController();
    const stale = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });
    const current = controller.begin({ cardIndex: 1, fileName: 'second.jpg' });

    expect(controller.complete(stale.id)).toBe(false);
    expect(controller.getActive()).toEqual(current);
  });

  it('invalidates and clears the current request', () => {
    const controller = ClassificationSession.createController();
    const request = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });

    expect(controller.invalidate(request.id)).toBe(true);
    expect(controller.getActive()).toBeNull();
  });

  it('does not let stale invalidation clear the current request', () => {
    const controller = ClassificationSession.createController();
    const stale = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });
    const current = controller.begin({ cardIndex: 1, fileName: 'second.jpg' });

    expect(controller.invalidate(stale.id)).toBe(false);
    expect(controller.getActive()).toEqual(current);
  });

  it('makes repeated invalidation safe and idempotent', () => {
    const controller = ClassificationSession.createController();
    const request = controller.begin({ cardIndex: 0, fileName: 'first.jpg' });

    expect(controller.invalidate(request.id)).toBe(true);
    expect(controller.invalidate(request.id)).toBe(false);
    expect(controller.getActive()).toBeNull();
  });

  it('retains the initiating card index in active context', () => {
    const controller = ClassificationSession.createController();
    controller.begin({ cardIndex: 7, fileName: 'leaf.jpg' });

    expect(controller.getActive().cardIndex).toBe(7);
  });

  it('protects controller-owned context from caller mutation', () => {
    const controller = ClassificationSession.createController();
    const request = controller.begin({ cardIndex: 2, fileName: 'leaf.jpg' });

    expect(Object.isFrozen(request)).toBe(true);
    expect(() => { request.cardIndex = 99; }).toThrow();
    const active = controller.getActive();
    expect(Object.isFrozen(active)).toBe(true);
    expect(active).toEqual({ id: 1, cardIndex: 2, fileName: 'leaf.jpg' });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { cardIndex: -1, fileName: 'leaf.jpg' },
    { cardIndex: 1.5, fileName: 'leaf.jpg' },
    { cardIndex: 0, fileName: '' },
    { cardIndex: 0, fileName: 42 }
  ])('rejects malformed request context safely: %#', (context) => {
    const controller = ClassificationSession.createController();

    expect(controller.begin(context)).toBeNull();
    expect(controller.getActive()).toBeNull();
  });

  it('leaves request A active while its deferred work is pending', async () => {
    const controller = ClassificationSession.createController();
    const requestA = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const workA = deferred();
    const resultA = acceptActiveResult(controller, requestA, workA.promise, []);

    expect(controller.isActive(requestA.id)).toBe(true);
    controller.invalidate(requestA.id);
    workA.resolve('cancelled prediction');
    await resultA;
  });

  it('lets request B supersede pending request A', () => {
    const controller = ClassificationSession.createController();
    const requestA = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const requestB = controller.begin({ cardIndex: 1, fileName: 'b.jpg' });

    expect(controller.isActive(requestA.id)).toBe(false);
    expect(controller.getActive()).toEqual(requestB);
  });

  it('marks A stale when A resolves after B begins', async () => {
    const controller = ClassificationSession.createController();
    const acceptedResults = [];
    const requestA = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const workA = deferred();
    const resultA = acceptActiveResult(controller, requestA, workA.promise, acceptedResults);
    controller.begin({ cardIndex: 1, fileName: 'b.jpg' });

    workA.resolve('old prediction');

    await expect(resultA).resolves.toEqual({ status: 'stale' });
  });

  it('prevents stale A from updating accepted result state', async () => {
    const controller = ClassificationSession.createController();
    const acceptedResults = [];
    const requestA = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const workA = deferred();
    const resultA = acceptActiveResult(controller, requestA, workA.promise, acceptedResults);
    controller.begin({ cardIndex: 1, fileName: 'b.jpg' });

    workA.resolve('old prediction');
    await resultA;

    expect(acceptedResults).toEqual([]);
  });

  it('keeps B authoritative when A settles later', async () => {
    const controller = ClassificationSession.createController();
    const acceptedResults = [];
    const requestA = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const workA = deferred();
    const resultA = acceptActiveResult(controller, requestA, workA.promise, acceptedResults);
    const requestB = controller.begin({ cardIndex: 1, fileName: 'b.jpg' });
    const workB = deferred();
    const resultB = acceptActiveResult(controller, requestB, workB.promise, acceptedResults);

    workB.resolve('new prediction');
    await resultB;
    workA.resolve('old prediction');
    await resultA;

    expect(controller.getActive()).toEqual(requestB);
    expect(acceptedResults).toEqual([{ requestId: requestB.id, value: 'new prediction' }]);
  });

  it('distinguishes a stale rejection without affecting B', async () => {
    const controller = ClassificationSession.createController();
    const requestA = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const workA = deferred();
    const resultA = acceptActiveResult(controller, requestA, workA.promise, []);
    const requestB = controller.begin({ cardIndex: 1, fileName: 'b.jpg' });

    const error = new Error('A failed late');
    workA.reject(error);

    await expect(resultA).resolves.toEqual({ status: 'stale_error', error });
    expect(controller.getActive()).toEqual(requestB);
  });

  it('distinguishes a current rejection', async () => {
    const controller = ClassificationSession.createController();
    const request = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const work = deferred();
    const result = acceptActiveResult(controller, request, work.promise, []);

    const error = new Error('current failure');
    work.reject(error);

    await expect(result).resolves.toEqual({ status: 'current_error', error });
    expect(controller.isActive(request.id)).toBe(true);
  });

  it('suppresses a result when cancellation happens before resolution', async () => {
    const controller = ClassificationSession.createController();
    const acceptedResults = [];
    const request = controller.begin({ cardIndex: 0, fileName: 'a.jpg' });
    const work = deferred();
    const result = acceptActiveResult(controller, request, work.promise, acceptedResults);

    controller.invalidate(request.id);
    work.resolve('cancelled prediction');

    await expect(result).resolves.toEqual({ status: 'stale' });
    expect(acceptedResults).toEqual([]);
  });
});

describe('classification source integration contracts', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const serviceWorkerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');
  const selectionSource = source.slice(
    source.indexOf('async function handleFileSelect'),
    source.indexOf('function openModalForRequest')
  );
  const classificationSource = source.slice(
    source.indexOf('async function classifyImageForRequest'),
    source.indexOf('function closeModal')
  );
  const cancellationSource = source.slice(
    source.indexOf('function closeModal'),
    source.indexOf('function mapToLocalLabel')
  );
  const emptyCardSource = source.slice(
    source.indexOf('function configureEmptyCard'),
    source.indexOf('function addOrganismCard')
  );
  const modalVisibilitySource = source.slice(
    source.indexOf('function showClassificationModal'),
    source.indexOf('function resetFileInput')
  );
  const modalFocusSource = source.slice(
    source.indexOf('function modalFocusableControls'),
    source.indexOf('function resetFileInput')
  );
  const saveSource = source.slice(
    source.indexOf('function saveOrganismData'),
    source.indexOf('function updateCardDisplay')
  );

  it('loads the lifecycle module before application code', () => {
    const modulePosition = source.indexOf('<script src="src/utils/classificationSession.js"></script>');
    const applicationPosition = source.indexOf("document.addEventListener('DOMContentLoaded'");

    expect(modulePosition).toBeGreaterThan(-1);
    expect(modulePosition).toBeLessThan(applicationPosition);
  });

  it('precaches the lifecycle module under cache generation v17', () => {
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./src/utils/classificationSession.js'");
  });

  it('checks request activity after awaited file and downscale boundaries', () => {
    expect(selectionSource).toMatch(/await readFileAsDataURL\(file\);\s*if \(!classificationController\.isActive\(request\.id\)\) return;/);
    expect(selectionSource).toMatch(/await downscaleImage\(raw, 800\);\s*if \(!classificationController\.isActive\(request\.id\)\) return;/);
    expect(classificationSource).toMatch(/await loadImage\(imageSrc\);/);
    expect(classificationSource).toMatch(/await requestModel\.classify\(image\);\s*if \(!classificationController\.isActive\(request\.id\)\) return/);
  });

  it('uses request-bound card and modal data when saving', () => {
    expect(saveSource).toContain('const cardIndex = activeRequest.cardIndex');
    expect(saveSource).toContain('pendingClassification.requestId !== activeRequest.id');
    expect(saveSource).toContain('modal.dataset.requestId !== String(activeRequest.id)');
    expect(saveSource).toContain('imgSrc: pendingClassification.imageSrc');
    expect(saveSource).not.toContain('currentCardIndex');
  });

  it('invalidates the active request when the modal is cancelled', () => {
    expect(cancellationSource).toContain('invalidateCurrentClassification(activeRequest)');
    expect(cancellationSource).toContain('resetClassificationModal()');
    expect(cancellationSource).toContain('hideClassificationModal({ restoreFocus: true })');
  });

  it('resets the file input on selection, cancellation, save, and terminal failure paths', () => {
    expect(selectionSource.match(/resetFileInput\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(cancellationSource).toContain('resetFileInput()');
    expect(saveSource).toContain('resetFileInput()');
  });

  it('removes callback-only classification and mutable card/lock globals', () => {
    expect(source).toContain('await classifyImageForRequest(request, imageSrc)');
    expect(source).not.toContain('await classifyImage(imgSrc)');
    expect(source).not.toMatch(/\b(?:let|var)\s+(?:currentCardIndex|isProcessingImage)\b/);
  });

  it('makes empty observation cards keyboard-operable with an accessible name', () => {
    expect(emptyCardSource).toContain('card.tabIndex = 0');
    expect(emptyCardSource).toContain("card.setAttribute('role', 'button')");
    expect(emptyCardSource).toContain("card.setAttribute('aria-label', `Tambah foto untuk observasi ${index + 1}`)");
    expect(emptyCardSource).toContain("event.key !== 'Enter' && event.key !== ' '");
  });

  it('keeps the modal out of the focus order while hidden and identifies it as a dialog', () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('aria-labelledby="identification-modal-title"');
    expect(source).toContain('aria-hidden="true" inert');
    expect(modalVisibilitySource).toContain('modal.inert = false');
    expect(modalVisibilitySource).toContain('modal.inert = true');
  });

  it('restores focus after modal close and supports Escape cancellation', () => {
    expect(modalVisibilitySource).toContain('focusTarget?.focus()');
    expect(source).toContain("event.key === 'Escape' && modal.classList.contains('visible')");
  });

  it('makes nonmodal regions inert and restores their previous inert states', () => {
    expect(modalFocusSource).toContain('modalBackgroundInertStates.set(region, region.inert)');
    expect(modalFocusSource).toContain('region.inert = true');
    expect(modalFocusSource).toContain('region.inert = wasInert');
    expect(modalFocusSource).toContain('restoreModalBackgroundInertState()');
  });

  it('focuses the intended first modal control and contains forward and reverse Tab', () => {
    expect(modalFocusSource).toContain('finalLabelInput.focus()');
    expect(modalFocusSource).toContain("event.key !== 'Tab'");
    expect(modalFocusSource).toContain('const activeIndex = controls.indexOf(document.activeElement)');
    expect(modalFocusSource).toContain('controls.length - 1 : 0');
    expect(modalFocusSource).toContain('% controls.length');
    expect(modalFocusSource).toContain('event.shiftKey');
    expect(modalFocusSource).toContain('controls[nextIndex].focus()');
    expect(modalFocusSource.match(/event\.preventDefault\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes disabled, hidden, and inert modal controls from focus containment', () => {
    expect(modalFocusSource).toContain('button:not([disabled])');
    expect(modalFocusSource).toContain('input:not([disabled])');
    expect(modalFocusSource).toContain('select:not([disabled])');
    expect(modalFocusSource).toContain("control.closest('[hidden], [inert], .hidden')");
    expect(modalFocusSource).toContain("style.display !== 'none'");
    expect(modalFocusSource).toContain("style.visibility !== 'hidden'");
  });

  it('restores successful saves to the filled card count input', () => {
    expect(modalVisibilitySource).toContain("card.querySelector('.count-badge input')");
    expect(saveSource).toContain('updateCardDisplay(cardIndex)');
    expect(saveSource).toContain('hideClassificationModal({ restoreFocus: true })');
  });

  it('does not trap focus while hidden or accumulate containment handlers', () => {
    expect(modalFocusSource).toContain("if (modal.classList.contains('visible')) return");
    expect(modalFocusSource).toContain("modal.addEventListener('keydown', containModalFocus)");
    expect(modalFocusSource).toContain("modal.removeEventListener('keydown', containModalFocus)");
    expect(modalFocusSource).toContain('modalFocusTrapActive = false');
    expect(modalFocusSource).toContain('modal.inert = true');
    expect(modalFocusSource).toContain("modal.setAttribute('aria-hidden', 'true')");
  });

  it('provides visible Coach labelling and accessible names for dynamic card controls', () => {
    expect(source).toContain('<label for="userInput" class="coach-input-label">Jawaban untuk Coach</label>');
    expect(source).toContain("del.setAttribute('aria-label', `Hapus observasi ${displayLabel}`)");
    expect(source).toContain("inp.setAttribute('aria-label', `Jumlah individu untuk ${displayLabel}`)");
  });
});
