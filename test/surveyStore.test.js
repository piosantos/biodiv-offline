import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import SurveyStore from '../src/utils/surveyStore.js';

function record(id, overrides = {}) {
  return {
    id,
    imgSrc: `data:image/png;base64,slot-${id}`,
    modelCandidate: null,
    finalLabel: `Kategori ${id}`,
    taxonomicLevel: 'broad_category',
    verificationStatus: 'unverified',
    verificationEvidence: '',
    count: 1,
    recordSource: 'user',
    ...overrides
  };
}

function entry(slotIndex, overrides = {}) {
  return {
    slotIndex,
    record: record(slotIndex, overrides)
  };
}

function snapshot(observations, overrides = {}) {
  return {
    schemaVersion: SurveyStore.SNAPSHOT_SCHEMA_VERSION,
    revision: 1,
    savedAt: '2026-07-24T00:00:00.000Z',
    observations,
    ...overrides
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function createFakeIndexedDB(options = {}) {
  const databases = new Map();
  const settings = {
    heldTransactions: [],
    heldOpenRequests: [],
    requestSuccesses: [],
    transactions: [],
    ...options
  };
  let transactionId = 0;

  class FakeTransaction {
    constructor(storeData, mode, log) {
      this.storeData = storeData;
      this.workingData = new Map(
        [...storeData.entries()].map(([key, value]) => [key, clone(value)])
      );
      this.mode = mode;
      this.log = log;
      this.error = null;
      this.pending = 0;
      this.aborted = false;
      this.completed = false;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.held = false;
      queueMicrotask(() => this.maybeComplete());
    }

    begin() {
      this.pending += 1;
    }

    end() {
      this.pending -= 1;
      queueMicrotask(() => this.maybeComplete());
    }

    maybeComplete() {
      if (!this.aborted && !this.completed && this.pending === 0) {
        if (settings.holdTransactionCompletion && !this.held) {
          this.held = true;
          settings.heldTransactions.push(this);
          return;
        }
        this.completed = true;
        if (this.mode === 'readwrite') {
          this.storeData.clear();
          this.workingData.forEach((value, key) => this.storeData.set(key, clone(value)));
        }
        this.oncomplete?.();
      }
    }

    release() {
      if (!this.held || this.aborted || this.completed) return;
      this.held = false;
      this.completed = true;
      if (this.mode === 'readwrite') {
        this.storeData.clear();
        this.workingData.forEach((value, key) => this.storeData.set(key, clone(value)));
      }
      this.oncomplete?.();
    }

    abort(error = null) {
      if (this.aborted || this.completed) return;
      this.aborted = true;
      this.error = error;
      queueMicrotask(() => this.onabort?.());
    }

    objectStore() {
      const transaction = this;
      return {
        get(key) {
          const request = {};
          transaction.log.operations.push({ operation: 'get', key });
          transaction.begin();
          queueMicrotask(() => {
            if (transaction.aborted) return transaction.end();
            if (settings.failReads) {
              request.error = Object.assign(new Error('read failed'), { name: 'UnknownError' });
              request.onerror?.();
              transaction.abort(request.error);
              transaction.end();
              return;
            }
            request.result = clone(transaction.workingData.get(key));
            request.onsuccess?.();
            settings.requestSuccesses.push({ operation: 'get', key });
            if (settings.abortReadAfterSuccess) {
              const errorName = settings.readAbortErrorName || 'UnknownError';
              transaction.abort(Object.assign(new Error('readonly transaction aborted'), {
                name: errorName
              }));
            }
            transaction.end();
          });
          return request;
        },
        getKey(key) {
          const request = {};
          transaction.log.operations.push({ operation: 'getKey', key });
          transaction.begin();
          queueMicrotask(() => {
            if (transaction.aborted) return transaction.end();
            if (settings.failReads) {
              request.error = Object.assign(new Error('read failed'), { name: 'UnknownError' });
              request.onerror?.();
              transaction.abort(request.error);
              transaction.end();
              return;
            }
            request.result = transaction.workingData.has(key) ? key : undefined;
            request.onsuccess?.();
            settings.requestSuccesses.push({ operation: 'getKey', key });
            transaction.end();
          });
          return request;
        },
        put(value, key) {
          const request = {};
          transaction.log.operations.push({ operation: 'put', key });
          transaction.begin();
          queueMicrotask(() => {
            if (transaction.aborted) return transaction.end();
            if (settings.failWrites) {
              const errorName = settings.writeErrorName || 'UnknownError';
              request.error = Object.assign(new Error('write failed'), { name: errorName });
              request.onerror?.();
              transaction.abort(request.error);
              transaction.end();
              return;
            }
            transaction.workingData.set(key, clone(value));
            request.result = key;
            request.onsuccess?.();
            settings.requestSuccesses.push({ operation: 'put', key });
            if (settings.abortAfterWriteSuccess) {
              const errorName = settings.abortErrorName || 'UnknownError';
              transaction.abort(Object.assign(new Error('transaction aborted'), { name: errorName }));
            }
            transaction.end();
          });
          return request;
        },
        delete(key) {
          const request = {};
          transaction.log.operations.push({ operation: 'delete', key });
          transaction.begin();
          queueMicrotask(() => {
            if (transaction.aborted) return transaction.end();
            transaction.workingData.delete(key);
            request.onsuccess?.();
            settings.requestSuccesses.push({ operation: 'delete', key });
            transaction.end();
          });
          return request;
        }
      };
    }
  }

  class FakeDatabase {
    constructor(name) {
      this.name = name;
      this.stores = new Map();
      this.closed = false;
      this.closeCount = 0;
      this.transactionCount = 0;
      this.objectStoreNames = {
        contains: (storeName) => this.stores.has(storeName)
      };
    }

    createObjectStore(storeName) {
      this.stores.set(storeName, new Map());
    }

    transaction(storeName, mode) {
      if (settings.failTransactions) throw new Error('transaction failed');
      if (this.closed) {
        throw Object.assign(new Error('database closed'), { name: 'InvalidStateError' });
      }
      this.transactionCount += 1;
      transactionId += 1;
      const log = { id: transactionId, mode, operations: [] };
      settings.transactions.push(log);
      return new FakeTransaction(this.stores.get(storeName), mode, log);
    }

    close() {
      this.closed = true;
      this.closeCount += 1;
    }
  }

  return {
    open(name) {
      const request = {};
      const completeOpen = () => {
        if (settings.failOpen) {
          request.error = new Error('open failed');
          request.onerror?.();
          return;
        }
        let database = databases.get(name);
        const created = !database;
        if (!database) {
          database = new FakeDatabase(name);
          databases.set(name, database);
        }
        request.result = database;
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      };
      queueMicrotask(() => {
        if (settings.holdOpenSuccess) {
          settings.heldOpenRequests.push(completeOpen);
          return;
        }
        completeOpen();
      });
      return request;
    },
    databases,
    settings,
    releaseNextTransaction() {
      settings.heldTransactions.shift()?.release();
    },
    releaseNextOpen() {
      settings.heldOpenRequests.shift()?.();
    }
  };
}

async function writeStoredValue(indexedDB, value) {
  const openRequest = indexedDB.open(SurveyStore.DATABASE_NAME, 1);
  await new Promise((resolve, reject) => {
    openRequest.onupgradeneeded = () => {
      if (!openRequest.result.objectStoreNames.contains(SurveyStore.OBJECT_STORE_NAME)) {
        openRequest.result.createObjectStore(SurveyStore.OBJECT_STORE_NAME);
      }
    };
    openRequest.onsuccess = resolve;
    openRequest.onerror = reject;
  });
  await new Promise((resolve, reject) => {
    const transaction = openRequest.result.transaction(SurveyStore.OBJECT_STORE_NAME, 'readwrite');
    transaction.objectStore(SurveyStore.OBJECT_STORE_NAME).put(value, SurveyStore.ACTIVE_SESSION_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = reject;
    transaction.onabort = reject;
  });
}

async function readStoredValue(indexedDB) {
  const openRequest = indexedDB.open(SurveyStore.DATABASE_NAME, 1);
  await new Promise((resolve, reject) => {
    openRequest.onsuccess = resolve;
    openRequest.onerror = reject;
  });
  return new Promise((resolve, reject) => {
    const transaction = openRequest.result.transaction(SurveyStore.OBJECT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(SurveyStore.OBJECT_STORE_NAME).get(
      SurveyStore.ACTIVE_SESSION_KEY
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = reject;
  });
}

describe('collision-safe clear guards', () => {
  it('returns the same token for the same supported nested value', () => {
    const value = { nested: [null, true, 'teks', -0, { count: 2 }] };
    expect(SurveyStore.createClearGuard(value)).toEqual(SurveyStore.createClearGuard(value));
    expect(SurveyStore.createClearGuard(value).supported).toBe(true);
  });

  it('sorts plain-object keys deterministically', () => {
    const left = SurveyStore.createClearGuard({ beta: 2, alpha: 1 });
    const right = SurveyStore.createClearGuard({ alpha: 1, beta: 2 });
    expect(left.token).toBe(right.token);
  });

  it.each([
    ['empty object and object containing null', {}, { value: null }],
    ['null and the string null', null, 'null'],
    ['zero and negative zero', 0, -0],
    ['numeric zero and string zero', 0, '0'],
    ['empty array and empty object', [], {}],
    ['empty array and array containing null', [], [null]],
    ['plain and null-prototype objects', {}, Object.create(null)]
  ])('distinguishes %s', (_label, left, right) => {
    const leftGuard = SurveyStore.createClearGuard(left);
    const rightGuard = SurveyStore.createClearGuard(right);
    expect(leftGuard.supported).toBe(true);
    expect(rightGuard.supported).toBe(true);
    expect(leftGuard.token).not.toBe(rightGuard.token);
  });

  it('distinguishes shared references from duplicated values', () => {
    const shared = {};
    const sharedValue = { first: shared, second: shared };
    const duplicatedValue = { first: {}, second: {} };
    expect(SurveyStore.createClearGuard(sharedValue).token)
      .not.toBe(SurveyStore.createClearGuard(duplicatedValue).token);
  });

  it('accepts dense arrays and rejects sparse arrays', () => {
    expect(SurveyStore.createClearGuard([null]).supported).toBe(true);
    const sparse = Array(1);
    expect(SurveyStore.createClearGuard(sparse)).toEqual({
      supported: false,
      token: null,
      reason: 'unsupported_clear_guard_value'
    });
  });

  it.each([
    ['undefined', { value: undefined }],
    ['NaN', { value: Number.NaN }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }],
    ['function', { value() {} }],
    ['symbol', { value: Symbol('x') }],
    ['BigInt', { value: 1n }],
    ['Date', new Date('2026-07-24T00:00:00.000Z')],
    ['Map', new Map([['key', 'value']])],
    ['Set', new Set(['value'])],
    ['RegExp', /value/],
    ['ArrayBuffer', new ArrayBuffer(4)],
    ['typed array', new Uint8Array([1, 2])],
    ['custom prototype', Object.assign(Object.create({ inherited: true }), { value: 1 })]
  ])('rejects unsupported %s values', (_label, value) => {
    expect(SurveyStore.createClearGuard(value)).toEqual({
      supported: false,
      token: null,
      reason: 'unsupported_clear_guard_value'
    });
  });

  it('rejects cyclic structures', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(SurveyStore.createClearGuard(cyclic).supported).toBe(false);
  });

  it('rejects accessors without invoking them', () => {
    let invoked = false;
    const value = {};
    Object.defineProperty(value, 'unsafe', {
      enumerable: true,
      get() {
        invoked = true;
        return 'value';
      }
    });
    expect(SurveyStore.createClearGuard(value).supported).toBe(false);
    expect(invoked).toBe(false);
  });
});

describe('survey snapshot behavior', () => {
  it('creates an empty schema-v1 snapshot', () => {
    const result = SurveyStore.createSnapshot({ observations: [] }, {
      revision: 0,
      savedAt: '2026-07-24T00:00:00.000Z'
    });

    expect(result).toMatchObject({
      valid: true,
      snapshot: {
        schemaVersion: 1,
        revision: 0,
        savedAt: '2026-07-24T00:00:00.000Z',
        observations: []
      }
    });
  });

  it('creates a snapshot from valid sparse observations and preserves slot indexes', () => {
    const result = SurveyStore.createSnapshot({ observations: [entry(0), entry(7)] }, {
      revision: 2,
      savedAt: '2026-07-24T00:00:00.000Z'
    });

    expect(result.snapshot.observations.map((item) => item.slotIndex)).toEqual([0, 7]);
    expect(SurveyStore.restoreObservations(result.snapshot).observations[7]).toMatchObject({ id: 7 });
  });

  it('does not mutate input records', () => {
    const input = [entry(3)];
    const before = structuredClone(input);
    SurveyStore.createSnapshot({ observations: input }, {
      revision: 1,
      savedAt: '2026-07-24T00:00:00.000Z'
    });
    expect(input).toEqual(before);
  });

  it('rejects unsupported schema versions', () => {
    expect(SurveyStore.validateSnapshot(snapshot([], { schemaVersion: 2 }))).toMatchObject({
      valid: false,
      errorCode: 'unsupported_schema_version'
    });
  });

  it.each([
    ['invalid revision', { revision: -1 }, 'invalid_revision'],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_revision'],
    ['invalid timestamp', { savedAt: 'yesterday' }, 'invalid_saved_at']
  ])('rejects %s', (_label, overrides, errorCode) => {
    expect(SurveyStore.validateSnapshot(snapshot([], overrides))).toMatchObject({
      valid: false,
      errorCode
    });
  });

  it('accepts only non-negative safe-integer revisions', () => {
    expect(SurveyStore.isValidRevision(0)).toBe(true);
    expect(SurveyStore.isValidRevision(Number.MAX_SAFE_INTEGER - 1)).toBe(true);
    expect(SurveyStore.isValidRevision(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(SurveyStore.isValidRevision(-1)).toBe(false);
    expect(SurveyStore.isValidRevision(1.5)).toBe(false);
    expect(SurveyStore.isValidRevision(Number.POSITIVE_INFINITY)).toBe(false);
    expect(SurveyStore.isValidRevision(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('excludes an invalid slot index with a stable warning', () => {
    const result = SurveyStore.validateSnapshot(snapshot([
      { slotIndex: SurveyStore.MAX_SLOT_COUNT, record: record(SurveyStore.MAX_SLOT_COUNT) }
    ]));
    expect(result.snapshot.observations).toEqual([]);
    expect(result.warnings).toEqual([{ index: 0, reason: 'invalid_slot_index' }]);
  });

  it('accepts zero-based slot 11 and rejects slot 12', () => {
    const result = SurveyStore.validateSnapshot(snapshot([
      entry(SurveyStore.MAX_SLOT_COUNT - 1),
      entry(SurveyStore.MAX_SLOT_COUNT)
    ]));
    expect(result.snapshot.observations.map((item) => item.slotIndex)).toEqual([11]);
    expect(result.warnings).toEqual([{ index: 1, reason: 'invalid_slot_index' }]);
  });

  it('rejects every member of a duplicate slot instead of choosing one', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(2), entry(2, { finalLabel: 'Lain' })]));
    expect(result.snapshot.observations).toEqual([]);
    expect(result.warnings).toEqual([
      { index: 0, slotIndex: 2, reason: 'duplicate_slot_index' },
      { index: 1, slotIndex: 2, reason: 'duplicate_slot_index' }
    ]);
  });

  it('excludes a record whose ID does not own its slot', () => {
    const result = SurveyStore.validateSnapshot(snapshot([{ slotIndex: 3, record: record(4) }]));
    expect(result.snapshot.observations).toEqual([]);
    expect(result.warnings[0].reason).toBe('record_id_slot_mismatch');
  });

  it('excludes an invalid canonical record', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(0, { count: 0 })]));
    expect(result.snapshot.observations).toEqual([]);
    expect(result.warnings[0]).toMatchObject({
      reason: 'invalid_observation_record',
      recordErrors: ['zero_count']
    });
  });

  it('restores valid records when another entry is corrupt', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(5), entry(1, { count: 0 })]));
    expect(result.snapshot.observations).toEqual([entry(5)]);
    expect(result.warnings).toHaveLength(1);
    expect(result.droppedEntryCount).toBe(1);
  });

  it('sorts restored entries deterministically', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(8), entry(1), entry(4)]));
    expect(result.snapshot.observations.map((item) => item.slotIndex)).toEqual([1, 4, 8]);
  });

  it('excludes transient state from canonical snapshot records', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(0, {
      requestId: 77,
      pendingClassification: { requestId: 77 },
      assessmentStates: { pre: { score: 100 } },
      practice: { responses: { q1: 'x' } },
      chatHistory: [{ role: 'coach' }],
      generatedPdf: 'data:application/pdf;base64,test'
    })]));

    expect(result.snapshot.observations[0].record).not.toHaveProperty('requestId');
    expect(result.snapshot.observations[0].record).not.toHaveProperty('pendingClassification');
    expect(result.snapshot.observations[0].record).not.toHaveProperty('assessmentStates');
    expect(result.snapshot.observations[0].record).not.toHaveProperty('practice');
    expect(result.snapshot.observations[0].record).not.toHaveProperty('chatHistory');
    expect(result.snapshot.observations[0].record).not.toHaveProperty('generatedPdf');
  });

  it('serializes special-character labels without HTML encoding', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(0, {
      finalLabel: 'A & B <contoh>'
    })]));
    expect(result.snapshot.observations[0].record.finalLabel).toBe('A & B <contoh>');
  });

  it('preserves unresolved records correctly', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(0, {
      finalLabel: '',
      taxonomicLevel: 'unknown',
      verificationStatus: 'unresolved'
    })]));
    expect(result.snapshot.observations[0].record).toMatchObject({
      finalLabel: '',
      taxonomicLevel: 'unknown',
      verificationStatus: 'unresolved'
    });
  });

  it('preserves structured model candidates', () => {
    const modelCandidate = { rawClassName: 'nematode', suggestedLabel: 'Nematode', score: 0.049 };
    const result = SurveyStore.validateSnapshot(snapshot([entry(0, { modelCandidate })]));
    expect(result.snapshot.observations[0].record.modelCandidate).toEqual(modelCandidate);
  });

  it('rejects an unresolved record containing a final label', () => {
    const result = SurveyStore.validateSnapshot(snapshot([entry(0, {
      finalLabel: 'Tidak boleh',
      taxonomicLevel: 'unknown',
      verificationStatus: 'unresolved'
    })]));
    expect(result.snapshot.observations).toEqual([]);
    expect(result.warnings[0].recordErrors).toContain('unresolved_final_label_present');
  });

  it('rejects a cleared snapshot containing observations', () => {
    expect(SurveyStore.validateSnapshot(snapshot([entry(0)], { cleared: true }))).toMatchObject({
      valid: false,
      errorCode: 'invalid_clear_marker',
      warnings: [{ reason: 'cleared_snapshot_has_observations' }]
    });
  });
});

describe('invalid-draft merge policy', () => {
  it('retains an invalid slot last-valid value while persisting deletion elsewhere', () => {
    const previous = [entry(0, { count: 5 }), entry(1, { count: 2 })];
    const current = [record(0, { count: 0 }), null];
    expect(SurveyStore.mergePersistableEntries(current, previous)).toEqual([entry(0, { count: 5 })]);
  });

  it('removes an invalid slot when that slot is deleted', () => {
    expect(SurveyStore.mergePersistableEntries([null], [entry(0, { count: 5 })])).toEqual([]);
  });

  it('retains an invalid slot and adds a new valid observation elsewhere', () => {
    const current = [record(0, { count: 0 }), null, record(2, { count: 3 })];
    expect(SurveyStore.mergePersistableEntries(current, [entry(0, { count: 5 })])).toEqual([
      entry(0, { count: 5 }),
      entry(2, { count: 3 })
    ]);
  });

  it('replaces a last-valid count after the invalid draft is corrected', () => {
    expect(SurveyStore.mergePersistableEntries(
      [record(0, { count: 9 })],
      [entry(0, { count: 5 })]
    )).toEqual([entry(0, { count: 9 })]);
  });

  it('does not mutate current records or previous entries', () => {
    const current = [record(0, { count: 0 })];
    const previous = [entry(0, {
      count: 5,
      modelCandidate: { rawClassName: 'leaf', suggestedLabel: 'Daun', score: 0.5 }
    })];
    const before = clone({ current, previous });
    const merged = SurveyStore.mergePersistableEntries(current, previous);
    merged[0].record.modelCandidate.suggestedLabel = 'Diubah';
    expect({ current, previous }).toEqual(before);
  });
});

describe('survey store with injected IndexedDB', () => {
  it('returns no snapshot for an empty database', async () => {
    const store = SurveyStore.createStore({ indexedDB: createFakeIndexedDB() });
    expect(await store.load()).toMatchObject({ ok: true, status: 'empty', snapshot: null });
  });

  it('closes a database that opens after store close and never starts a transaction', async () => {
    const indexedDB = createFakeIndexedDB({ holdOpenSuccess: true });
    const store = SurveyStore.createStore({ indexedDB });
    const loading = store.load();
    await waitForCondition(() => indexedDB.settings.heldOpenRequests.length === 1);
    store.close();
    indexedDB.releaseNextOpen();

    expect(await loading).toMatchObject({ ok: false, errorCode: 'store_closed' });
    const database = indexedDB.databases.get(SurveyStore.DATABASE_NAME);
    expect(database.closed).toBe(true);
    expect(database.closeCount).toBe(1);
    expect(database.transactionCount).toBe(0);
    expect(await store.load()).toMatchObject({ ok: false, errorCode: 'store_closed' });
    expect(await store.save({ observations: [] })).toMatchObject({
      ok: false,
      errorCode: 'store_closed'
    });
    expect(await store.clear()).toMatchObject({ ok: false, errorCode: 'store_closed' });
  });

  it('lets an operation already inside a transaction settle after store close', async () => {
    const indexedDB = createFakeIndexedDB({ holdTransactionCompletion: true });
    const store = SurveyStore.createStore({ indexedDB });
    let settled = false;
    const loading = store.load().then((result) => { settled = true; return result; });
    await waitForCondition(() => indexedDB.settings.requestSuccesses.some((event) => event.operation === 'get'));
    expect(settled).toBe(false);
    store.close();
    indexedDB.releaseNextTransaction();
    expect(await loading).toMatchObject({ ok: true, status: 'empty', revision: 0 });
  });

  it('classifies a load request error without changing the accepted revision', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0, { count: 4 })] }, { expectedRevision: 0 });
    indexedDB.settings.failReads = true;
    expect(await store.load()).toMatchObject({ ok: false, errorCode: 'transaction_failed' });
    indexedDB.settings.failReads = false;
    expect(await store.save({ observations: [entry(0, { count: 5 })] })).toMatchObject({
      ok: true,
      snapshot: { revision: 2 }
    });
  });

  it('classifies readonly abort after request success without changing the accepted revision', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0, { count: 4 })] }, { expectedRevision: 0 });
    indexedDB.settings.abortReadAfterSuccess = true;
    expect(await store.load()).toMatchObject({ ok: false, errorCode: 'transaction_failed' });
    indexedDB.settings.abortReadAfterSuccess = false;
    expect(await store.save({ observations: [entry(0, { count: 6 })] })).toMatchObject({
      ok: true,
      snapshot: { revision: 2 }
    });
  });

  it('uses revision 1 for the first save and increments later saves', async () => {
    const store = SurveyStore.createStore({ indexedDB: createFakeIndexedDB() });
    const first = await store.save({ observations: [entry(0)] }, {
      expectedRevision: 0,
      savedAt: '2026-07-24T00:00:00.000Z'
    });
    const second = await store.save({ observations: [entry(0, { count: 2 })] }, {
      expectedRevision: 1,
      savedAt: '2026-07-24T00:01:00.000Z'
    });
    expect(first.snapshot.revision).toBe(1);
    expect(second.snapshot.revision).toBe(2);
  });

  it('increments MAX_SAFE_INTEGER minus one exactly once and then reports overflow', async () => {
    const indexedDB = createFakeIndexedDB();
    await writeStoredValue(indexedDB, snapshot([entry(0)], {
      revision: Number.MAX_SAFE_INTEGER - 1
    }));
    const store = SurveyStore.createStore({ indexedDB });
    await store.load();
    const maximum = await store.save({ observations: [entry(0, { count: 2 })] });
    expect(maximum).toMatchObject({
      ok: true,
      snapshot: { revision: Number.MAX_SAFE_INTEGER }
    });
    const transactionCount = indexedDB.settings.transactions.length;
    const overflow = await store.save({ observations: [entry(0, { count: 3 })] });
    expect(overflow).toMatchObject({ ok: false, errorCode: 'revision_overflow' });
    expect(indexedDB.settings.transactions).toHaveLength(transactionCount);
    expect((await store.load()).snapshot).toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      observations: [{ record: { count: 2 } }]
    });
  });

  it('does not clear or mutate caller state when the revision would overflow', async () => {
    const indexedDB = createFakeIndexedDB();
    const stored = snapshot([entry(0, { count: 5 })], {
      revision: Number.MAX_SAFE_INTEGER
    });
    await writeStoredValue(indexedDB, stored);
    const store = SurveyStore.createStore({ indexedDB });
    await store.load();
    const options = { expectedRevision: Number.MAX_SAFE_INTEGER };
    const transactionCount = indexedDB.settings.transactions.length;
    expect(await store.clear(options)).toMatchObject({
      ok: false,
      errorCode: 'revision_overflow'
    });
    expect(options).toEqual({ expectedRevision: Number.MAX_SAFE_INTEGER });
    expect(indexedDB.settings.transactions).toHaveLength(transactionCount + 1);
    expect(await readStoredValue(indexedDB)).toEqual(stored);
  });

  it('uses guarded revision 1 when force-clearing an unreadable unsafe revision', async () => {
    const indexedDB = createFakeIndexedDB();
    await writeStoredValue(indexedDB, {
      schemaVersion: SurveyStore.SNAPSHOT_SCHEMA_VERSION,
      revision: Number.MAX_SAFE_INTEGER + 1,
      savedAt: '2026-07-24T00:00:00.000Z',
      observations: []
    });
    const store = SurveyStore.createStore({ indexedDB });
    const inspected = await store.load();
    expect(inspected).toMatchObject({
      ok: false,
      errorCode: 'invalid_revision'
    });
    expect(await store.clear({
      expectedRevision: 0,
      force: true,
      clearToken: inspected.clearToken
    })).toMatchObject({
      ok: true,
      revision: 1,
      tombstone: true
    });
  });

  it('uses one readwrite transaction for each save revision get and put', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    const before = indexedDB.settings.transactions.length;
    await store.save({ observations: [entry(0)] }, { expectedRevision: 0 });
    const transactions = indexedDB.settings.transactions.slice(before);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      mode: 'readwrite',
      operations: [
        { operation: 'get', key: SurveyStore.ACTIVE_SESSION_KEY },
        { operation: 'put', key: SurveyStore.ACTIVE_SESSION_KEY }
      ]
    });
  });

  it('loads the saved snapshot', async () => {
    const indexedDB = createFakeIndexedDB();
    const writer = SurveyStore.createStore({ indexedDB });
    await writer.save({ observations: [entry(4)] }, { expectedRevision: 0 });
    const reader = SurveyStore.createStore({ indexedDB });
    expect(await reader.load()).toMatchObject({
      ok: true,
      status: 'loaded',
      snapshot: { revision: 1, observations: [{ slotIndex: 4 }] }
    });
  });

  it('clear removes the active snapshot', async () => {
    const store = SurveyStore.createStore({ indexedDB: createFakeIndexedDB() });
    await store.save({ observations: [entry(0)] }, { expectedRevision: 0 });
    expect(await store.clear({ expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(await store.load()).toMatchObject({
      ok: true,
      status: 'empty',
      snapshot: null,
      revision: 2,
      tombstone: true
    });
  });

  it('uses one readwrite transaction for each clear revision get and tombstone put', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0)] }, { expectedRevision: 0 });
    const before = indexedDB.settings.transactions.length;
    await store.clear({ expectedRevision: 1 });
    const transactions = indexedDB.settings.transactions.slice(before);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      mode: 'readwrite',
      operations: [
        { operation: 'get', key: SurveyStore.ACTIVE_SESSION_KEY },
        { operation: 'put', key: SurveyStore.ACTIVE_SESSION_KEY }
      ]
    });
  });

  it('returns invalid_saved_at before clear writes and preserves the accepted revision', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0, { count: 5 })] }, { expectedRevision: 0 });
    const before = indexedDB.settings.transactions.length;
    expect(await store.clear({
      expectedRevision: 1,
      savedAt: 'invalid'
    })).toMatchObject({
      ok: false,
      errorCode: 'invalid_saved_at'
    });
    expect(indexedDB.settings.transactions).toHaveLength(before);
    expect((await store.load()).snapshot).toMatchObject({
      revision: 1,
      observations: [{ record: { count: 5 } }]
    });
    expect(await store.clear({
      savedAt: '2026-07-24T01:00:00.000Z'
    })).toMatchObject({
      ok: true,
      revision: 2
    });
  });

  it.each([
    ['transaction failure', createFakeIndexedDB({ failTransactions: true }), 'transaction_failed'],
    ['quota exhaustion', createFakeIndexedDB({ failWrites: true, writeErrorName: 'QuotaExceededError' }), 'quota_exceeded']
  ])('returns a structured error for %s', async (_label, indexedDB, errorCode) => {
    const store = SurveyStore.createStore({ indexedDB });
    expect(await store.save({ observations: [entry(0)] }, { expectedRevision: 0 })).toMatchObject({
      ok: false,
      errorCode
    });
  });

  it('returns a structured database-open failure', async () => {
    const store = SurveyStore.createStore({ indexedDB: createFakeIndexedDB({ failOpen: true }) });
    expect(await store.load()).toMatchObject({ ok: false, errorCode: 'database_open_failed' });
  });

  it('does not save a snapshot containing invalid entries', async () => {
    const store = SurveyStore.createStore({ indexedDB: createFakeIndexedDB() });
    expect(await store.save({ observations: [entry(0, { count: 0 })] }, {
      expectedRevision: 0
    })).toMatchObject({
      ok: false,
      errorCode: 'invalid_snapshot'
    });
    expect(await store.load()).toMatchObject({ ok: true, status: 'empty' });
  });

  it('reports missing IndexedDB as storage unavailable', async () => {
    const store = SurveyStore.createStore({ indexedDB: null });
    expect(await store.load()).toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
  });

  it('prevents a revision conflict from overwriting newer data', async () => {
    const indexedDB = createFakeIndexedDB();
    const pageA = SurveyStore.createStore({ indexedDB });
    const pageB = SurveyStore.createStore({ indexedDB });
    await Promise.all([pageA.load(), pageB.load()]);
    await pageA.save({ observations: [entry(0, { finalLabel: 'A' })] }, { expectedRevision: 0 });
    const conflict = await pageB.save({ observations: [entry(0, { finalLabel: 'B' })] }, {
      expectedRevision: 0
    });
    expect(conflict).toMatchObject({
      ok: false,
      errorCode: 'revision_conflict',
      conflict: { expectedRevision: 0, storedRevision: 1 }
    });
    expect((await pageA.load()).snapshot.observations[0].record.finalLabel).toBe('A');
  });

  it('does not resolve save on request success before transaction completion', async () => {
    const indexedDB = createFakeIndexedDB({ holdTransactionCompletion: true });
    const store = SurveyStore.createStore({ indexedDB });
    let settled = false;
    const saving = store.save({ observations: [entry(0)] }, { expectedRevision: 0 })
      .then((result) => {
        settled = true;
        return result;
      });
    await waitForCondition(
      () => indexedDB.settings.requestSuccesses.some((event) => event.operation === 'put'),
      'put request did not succeed'
    );
    expect(indexedDB.settings.requestSuccesses.some((event) => event.operation === 'put')).toBe(true);
    expect(settled).toBe(false);
    indexedDB.releaseNextTransaction();
    expect(await saving).toMatchObject({ ok: true, snapshot: { revision: 1 } });
  });

  it('does not resolve clear on request success before transaction completion', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0)] }, { expectedRevision: 0 });
    indexedDB.settings.holdTransactionCompletion = true;
    let settled = false;
    const clearing = store.clear({ expectedRevision: 1 }).then((result) => {
      settled = true;
      return result;
    });
    await waitForCondition(
      () => indexedDB.settings.requestSuccesses.at(-1)?.operation === 'put',
      'clear tombstone put request did not succeed'
    );
    expect(indexedDB.settings.requestSuccesses.at(-1).operation).toBe('put');
    expect(settled).toBe(false);
    indexedDB.releaseNextTransaction();
    expect(await clearing).toMatchObject({ ok: true, revision: 2, tombstone: true });
  });

  it.each([
    ['transaction abort', 'UnknownError', 'transaction_failed'],
    ['quota-related abort', 'QuotaExceededError', 'quota_exceeded']
  ])('classifies %s after request success and preserves the previous snapshot',
    async (_label, abortErrorName, errorCode) => {
      const indexedDB = createFakeIndexedDB();
      const store = SurveyStore.createStore({ indexedDB });
      await store.save({ observations: [entry(0, { count: 5 })] }, { expectedRevision: 0 });
      indexedDB.settings.abortAfterWriteSuccess = true;
      indexedDB.settings.abortErrorName = abortErrorName;
      const failed = await store.save(
        { observations: [entry(0, { count: 8 })] },
        { expectedRevision: 1 }
      );
      expect(failed).toMatchObject({ ok: false, errorCode });
      indexedDB.settings.abortAfterWriteSuccess = false;
      const loaded = await store.load();
      expect(loaded.snapshot).toMatchObject({
        revision: 1,
        observations: [{ record: { count: 5 } }]
      });
      const retry = await store.save(
        { observations: [entry(0, { count: 9 })] },
        { savedAt: '2026-07-24T00:02:00.000Z' }
      );
      expect(retry).toMatchObject({ ok: true, snapshot: { revision: 2 } });
    });

  it('a failed clear does not claim removal or change the accepted revision', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0, { count: 5 })] }, { expectedRevision: 0 });
    indexedDB.settings.abortAfterWriteSuccess = true;
    const failed = await store.clear({ expectedRevision: 1 });
    expect(failed).toMatchObject({ ok: false, errorCode: 'transaction_failed', snapshot: null });
    indexedDB.settings.abortAfterWriteSuccess = false;
    expect((await store.load()).snapshot.observations[0].record.count).toBe(5);
    expect(await store.save(
      { observations: [entry(0, { count: 6 })] }
    )).toMatchObject({ ok: true, snapshot: { revision: 2 } });
  });

  it('keeps a revision tombstone so clear and recreation reject a stale tab', async () => {
    const indexedDB = createFakeIndexedDB();
    const pageA = SurveyStore.createStore({ indexedDB });
    const pageB = SurveyStore.createStore({ indexedDB });
    await Promise.all([pageA.load(), pageB.load()]);
    await pageA.save({ observations: [entry(0, { finalLabel: 'Awal' })] }, { expectedRevision: 0 });
    await pageB.load();
    const cleared = await pageA.clear({ expectedRevision: 1 });
    expect(cleared).toMatchObject({ ok: true, revision: 2 });
    const recreated = await pageA.save(
      { observations: [entry(0, { finalLabel: 'Baru' })] },
      { expectedRevision: 2 }
    );
    expect(recreated).toMatchObject({ ok: true, snapshot: { revision: 3 } });
    const stale = await pageB.save(
      { observations: [entry(0, { finalLabel: 'Lama' })] },
      { expectedRevision: 1 }
    );
    expect(stale).toMatchObject({
      ok: false,
      errorCode: 'revision_conflict',
      conflict: { expectedRevision: 1, storedRevision: 3 }
    });
    expect((await pageA.load()).snapshot.observations[0].record.finalLabel).toBe('Baru');
  });

  it('closing an opened store is safe, closes its database, and remains idempotent', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.load();
    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
    const database = indexedDB.databases.get(SurveyStore.DATABASE_NAME);
    expect(database.closed).toBe(true);
    expect(database.closeCount).toBe(1);
    expect(await store.load()).toMatchObject({ ok: false, errorCode: 'store_closed' });
  });

  it('can explicitly clear an unsupported stored snapshot without importing it', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    const openRequest = indexedDB.open(SurveyStore.DATABASE_NAME, 1);
    await new Promise((resolve) => {
      openRequest.onupgradeneeded = () => {
        if (!openRequest.result.objectStoreNames.contains(SurveyStore.OBJECT_STORE_NAME)) {
          openRequest.result.createObjectStore(SurveyStore.OBJECT_STORE_NAME);
        }
      };
      openRequest.onsuccess = resolve;
    });
    await new Promise((resolve) => {
      const transaction = openRequest.result.transaction(SurveyStore.OBJECT_STORE_NAME, 'readwrite');
      transaction.objectStore(SurveyStore.OBJECT_STORE_NAME).put(
        snapshot([], { schemaVersion: 99, revision: 7 }),
        SurveyStore.ACTIVE_SESSION_KEY
      );
      transaction.oncomplete = resolve;
    });
    const inspected = await store.load();
    expect(inspected).toMatchObject({ ok: false, errorCode: 'unsupported_schema_version' });
    expect(await store.clear({
      expectedRevision: 0,
      force: true,
      clearToken: inspected.clearToken
    })).toMatchObject({
      ok: true,
      revision: 8
    });
    expect(await store.load()).toMatchObject({
      ok: true,
      status: 'empty',
      revision: 8,
      tombstone: true
    });
  });

  it('does not clear an unsupported replacement using the guard for an empty object', async () => {
    const indexedDB = createFakeIndexedDB();
    await writeStoredValue(indexedDB, {});
    const stale = SurveyStore.createStore({ indexedDB });
    const inspected = await stale.load();
    expect(inspected.clearToken).toEqual(SurveyStore.createClearGuard({}).token);

    await writeStoredValue(indexedDB, { value: undefined });
    expect(await stale.clear({
      expectedRevision: 0,
      force: true,
      clearToken: inspected.clearToken
    })).toMatchObject({
      ok: false,
      errorCode: 'clear_not_supported'
    });
    expect(await readStoredValue(indexedDB)).toEqual({ value: undefined });
  });

  it('does not clear unsupported NaN using the guard for a null-valued object', async () => {
    const indexedDB = createFakeIndexedDB();
    await writeStoredValue(indexedDB, { value: null });
    const stale = SurveyStore.createStore({ indexedDB });
    const inspected = await stale.load();

    await writeStoredValue(indexedDB, { value: Number.NaN });
    expect(await stale.clear({
      expectedRevision: 0,
      force: true,
      clearToken: inspected.clearToken
    })).toMatchObject({
      ok: false,
      errorCode: 'clear_not_supported'
    });
    expect(Number.isNaN((await readStoredValue(indexedDB)).value)).toBe(true);
  });

  it.each([
    ['Date', new Date('2026-07-24T00:00:00.000Z')],
    ['Map', new Map([['key', 'value']])],
    ['typed array', new Uint8Array([1, 2, 3])]
  ])('does not issue a token or force-clear unsupported stored %s', async (_label, rawValue) => {
    const indexedDB = createFakeIndexedDB();
    await writeStoredValue(indexedDB, rawValue);
    const store = SurveyStore.createStore({ indexedDB });
    const inspected = await store.load();
    expect(inspected).toMatchObject({
      ok: false,
      errorCode: 'clear_not_supported',
      clearToken: null,
      clearGuardReason: 'unsupported_clear_guard_value'
    });
    expect(await store.clear({
      expectedRevision: 0,
      force: true,
      clearToken: inspected.clearToken
    })).toMatchObject({
      ok: false,
      errorCode: 'clear_not_supported'
    });
    expect(await readStoredValue(indexedDB)).toEqual(rawValue);
  });

  it('distinguishes a stored top-level undefined value from an absent key', async () => {
    const indexedDB = createFakeIndexedDB();
    await writeStoredValue(indexedDB, undefined);
    const storedData = indexedDB.databases
      .get(SurveyStore.DATABASE_NAME)
      .stores.get(SurveyStore.OBJECT_STORE_NAME);
    expect(storedData.has(SurveyStore.ACTIVE_SESSION_KEY)).toBe(true);

    const store = SurveyStore.createStore({ indexedDB });
    expect(await store.load()).toMatchObject({
      ok: false,
      status: 'invalid',
      errorCode: 'clear_not_supported',
      snapshotErrorCode: 'invalid_snapshot',
      clearToken: null,
      clearGuardReason: 'unsupported_clear_guard_value'
    });
    expect(await store.clear({
      expectedRevision: 0,
      force: true,
      clearToken: null
    })).toMatchObject({
      ok: false,
      errorCode: 'clear_not_supported'
    });
    expect(storedData.has(SurveyStore.ACTIVE_SESSION_KEY)).toBe(true);
    expect(await readStoredValue(indexedDB)).toBeUndefined();
  });

  it('caller mutation after save does not alter stored data', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    const input = { observations: [entry(0)] };
    await store.save(input, { expectedRevision: 0 });
    input.observations[0].record.finalLabel = 'Diubah';
    expect((await store.load()).snapshot.observations[0].record.finalLabel).toBe('Kategori 0');
  });

  it('loaded snapshot mutation does not alter stored data', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    await store.save({ observations: [entry(0)] }, { expectedRevision: 0 });
    const loaded = await store.load();
    loaded.snapshot.observations[0].record.finalLabel = 'Diubah';
    expect((await store.load()).snapshot.observations[0].record.finalLabel).toBe('Kategori 0');
  });

  it('isolates nested candidates, observation arrays, and warning arrays across loads', async () => {
    const indexedDB = createFakeIndexedDB();
    const store = SurveyStore.createStore({ indexedDB });
    const candidate = { rawClassName: 'leaf', suggestedLabel: 'Daun', score: 0.5 };
    await store.save({
      observations: [
        entry(0, { modelCandidate: candidate }),
        entry(1, { count: 0 })
      ]
    }, { expectedRevision: 0 }).then((result) => {
      expect(result.ok).toBe(false);
    });
    await store.save({
      observations: [entry(0, { modelCandidate: candidate })]
    }, { expectedRevision: 0 });
    const loaded = await store.load();
    loaded.snapshot.observations.push(entry(2));
    loaded.snapshot.observations[0].record.modelCandidate.suggestedLabel = 'Diubah';
    loaded.warnings.push({ reason: 'mutated' });
    const reloaded = await store.load();
    expect(reloaded.snapshot.observations).toHaveLength(1);
    expect(reloaded.snapshot.observations[0].record.modelCandidate.suggestedLabel).toBe('Daun');
    expect(reloaded.warnings).toEqual([]);
  });

  it('forced clear rejects a changed payload and preserves the newer value', async () => {
    const indexedDB = createFakeIndexedDB();
    const stale = SurveyStore.createStore({ indexedDB });
    const writer = SurveyStore.createStore({ indexedDB });
    const raw = snapshot([], { schemaVersion: 99, revision: 7 });
    const open = indexedDB.open(SurveyStore.DATABASE_NAME, 1);
    await new Promise((resolve) => { open.onsuccess = resolve; open.onupgradeneeded = () => open.result.createObjectStore(SurveyStore.OBJECT_STORE_NAME); });
    await new Promise((resolve) => {
      const tx = open.result.transaction(SurveyStore.OBJECT_STORE_NAME, 'readwrite');
      tx.objectStore(SurveyStore.OBJECT_STORE_NAME).put(raw, SurveyStore.ACTIVE_SESSION_KEY);
      tx.oncomplete = resolve;
    });
    const inspected = await stale.load();
    const cleared = await writer.clear({ expectedRevision: 0, force: true, clearToken: inspected.clearToken });
    expect(cleared).toMatchObject({ ok: true, revision: 8 });
    const repeated = await stale.clear({ expectedRevision: 0, force: true, clearToken: inspected.clearToken });
    expect(repeated).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
    await writer.save({ observations: [entry(0, { finalLabel: 'Baru' })] }, { expectedRevision: 8 });
    const conflict = await stale.clear({ expectedRevision: 0, force: true, clearToken: inspected.clearToken });
    expect(conflict).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
    expect((await writer.load()).snapshot.observations[0].record.finalLabel).toBe('Baru');
  });
});

describe('same-tab write coordinator', () => {
  it.each([
    ['rejected promise', () => Promise.reject(new Error('failed'))],
    ['synchronous throw', () => { throw new Error('failed'); }]
  ])('recovers after a %s', async (_label, failure) => {
    const coordinator = SurveyStore.createWriteCoordinator();
    await expect(coordinator.run(failure)).rejects.toThrow('failed');
    await expect(coordinator.run(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('scheduled failure does not poison a later immediate operation', async () => {
    const callbacks = [];
    const coordinator = SurveyStore.createWriteCoordinator({
      setTimeout(callback) { callbacks.push(callback); return callbacks.length; },
      clearTimeout() {}
    });
    coordinator.schedule(() => Promise.reject(new Error('scheduled')));
    callbacks[0]();
    await coordinator.drain();
    await expect(coordinator.run(async () => 'later')).resolves.toBe('later');
  });
  function createControlledPersistence() {
    const calls = [];
    let persisted = null;
    return {
      calls,
      read: () => clone(persisted),
      operation(value) {
        return () => {
          const gate = deferred();
          calls.push({ value: clone(value), gate });
          return gate.promise.then(() => {
            persisted = clone(value);
            return { ok: true, value: clone(value) };
          });
        };
      }
    };
  }

  it('persists rapid valid edits 5 → 6 → 7 → 8 in intended order', async () => {
    const persistence = createControlledPersistence();
    const coordinator = SurveyStore.createWriteCoordinator();
    const operations = [5, 6, 7, 8].map((count) => coordinator.run(
      persistence.operation({ observations: [entry(0, { count })] })
    ));
    await waitForCondition(() => persistence.calls.length === 1, 'first rapid edit did not start');
    for (let index = 0; index < 4; index += 1) {
      expect(persistence.calls).toHaveLength(index + 1);
      persistence.calls[index].gate.resolve();
      await operations[index];
      if (index < 3) {
        await waitForCondition(
          () => persistence.calls.length === index + 2,
          'next rapid edit did not start'
        );
      }
    }
    expect(persistence.calls.map((call) => call.value.observations[0].record.count)).toEqual([5, 6, 7, 8]);
    expect(persistence.read().observations[0].record.count).toBe(8);
  });

  it.each([
    ['save then delete', [entry(0)], []],
    ['sample load then clear', [entry(0), entry(1), entry(2), entry(3)], null],
    ['count edit then replacement', [entry(0, { count: 7 })], [entry(0, { finalLabel: 'Pengganti', count: 1 })]]
  ])('serializes %s so the later mutation wins', async (_label, firstValue, secondValue) => {
    const persistence = createControlledPersistence();
    const coordinator = SurveyStore.createWriteCoordinator();
    const first = coordinator.run(persistence.operation(firstValue));
    const second = coordinator.run(persistence.operation(secondValue));
    await waitForCondition(() => persistence.calls.length === 1, 'first mutation did not start');
    expect(persistence.calls).toHaveLength(1);
    persistence.calls[0].gate.resolve();
    await first;
    await waitForCondition(() => persistence.calls.length === 2, 'later mutation did not start');
    expect(persistence.calls).toHaveLength(2);
    persistence.calls[1].gate.resolve();
    await second;
    expect(persistence.read()).toEqual(secondValue);
  });

  it('cancels a pending debounced count save before clear', async () => {
    const timers = new Map();
    let timerId = 0;
    const calls = [];
    const coordinator = SurveyStore.createWriteCoordinator({
      delay: 350,
      setTimeout(callback) {
        timerId += 1;
        timers.set(timerId, callback);
        return timerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      }
    });
    coordinator.schedule(async () => {
      calls.push('stale-count');
    });
    await coordinator.run(async () => {
      calls.push('clear');
    });
    [...timers.values()].forEach((callback) => callback());
    await coordinator.drain();
    expect(calls).toEqual(['clear']);
  });

  it('allows a later immediate operation after explicit scheduled cancellation', async () => {
    const timers = [];
    const calls = [];
    const coordinator = SurveyStore.createWriteCoordinator({
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {}
    });
    coordinator.schedule(async () => calls.push('stale'));
    coordinator.cancelScheduled();
    await expect(coordinator.run(async () => {
      calls.push('fresh');
      return 'saved';
    })).resolves.toBe('saved');
    timers.forEach((callback) => callback());
    await coordinator.drain();
    expect(calls).toEqual(['fresh']);
  });

  it.each([
    'observation deletion',
    'sample-data replacement',
    'slot replacement',
    'revision conflict'
  ])('cancelScheduled prevents stale writes after %s', async () => {
    const timers = [];
    const calls = [];
    const coordinator = SurveyStore.createWriteCoordinator({
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {}
    });
    coordinator.schedule(async () => calls.push('stale'));
    coordinator.cancelScheduled();
    timers.forEach((callback) => callback());
    await coordinator.drain();
    expect(calls).toEqual([]);
  });

  it('close cancels pending debounce and rejects later work', async () => {
    const timers = [];
    const calls = [];
    const coordinator = SurveyStore.createWriteCoordinator({
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {}
    });
    coordinator.schedule(async () => calls.push('stale'));
    await coordinator.close();
    timers.forEach((callback) => callback());
    expect(await coordinator.run(async () => calls.push('late'))).toMatchObject({
      ok: false,
      errorCode: 'coordinator_closed'
    });
    expect(calls).toEqual([]);
  });

  it('supports repeated coordinator close without reviving scheduled or later work', async () => {
    const timers = [];
    const coordinator = SurveyStore.createWriteCoordinator({
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {}
    });
    coordinator.schedule(async () => 'stale');
    const firstClose = coordinator.close();
    const secondClose = coordinator.close();
    await expect(firstClose).resolves.toBeUndefined();
    await expect(secondClose).resolves.toBeUndefined();
    expect(coordinator.isClosed()).toBe(true);
    expect(coordinator.hasScheduled()).toBe(false);
    expect(await coordinator.run(async () => 'late')).toMatchObject({
      ok: false,
      errorCode: 'coordinator_closed'
    });
  });
});

describe('survey persistence source contracts', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const serviceWorkerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');

  it('loads SurveyStore after ObservationRecord and before application code', () => {
    const observationPosition = source.indexOf('<script src="src/utils/observationRecord.js"></script>');
    const storePosition = source.indexOf('<script src="src/utils/surveyStore.js"></script>');
    const applicationPosition = source.indexOf("document.addEventListener('DOMContentLoaded'");
    expect(storePosition).toBeGreaterThan(observationPosition);
    expect(storePosition).toBeLessThan(applicationPosition);
  });

  it('precaches SurveyStore under cache generation v17', () => {
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./src/utils/surveyStore.js'");
  });

  it('persists successful observation, valid count, delete, sample, and clear mutations', () => {
    expect(source).toContain('await persistSurveyNow()');
    expect(source).toContain('scheduleSurveySave()');
    expect(source).toContain('async function deleteOrganism');
    expect(source).toContain('async function loadSampleData');
    expect(source).toContain('async function clearLocalSurvey');
  });

  it('uses the shared slot limit and disables survey mutations until restore settles', () => {
    expect(source).toContain('surveyData.length >= SurveyStore.MAX_SLOT_COUNT');
    expect(source).toContain('Math.min(\n        SurveyStore.MAX_SLOT_COUNT');
    expect(source).toContain('setSurveyMutationControlsEnabled(false)');
    expect(source).toContain('setSurveyMutationControlsEnabled(true)');
    expect(source).toContain('surveyGrid.inert = !enabled');
  });

  it('uses the injected coordinator for immediate, debounced, and clear writes', () => {
    expect(source).toContain('SurveyStore.createWriteCoordinator({ delay: 350 })');
    expect(source).toContain('persistenceWrites.run(performSurveySave)');
    expect(source).toContain('persistenceWrites.schedule(performSurveySave)');
    expect(source).toContain('persistenceWrites.run(() => surveyStore.clear');
  });

  it('clears only survey state and leaves assessments, Coach history, and caches untouched', () => {
    const clearSource = source.slice(
      source.indexOf('async function clearLocalSurvey'),
      source.indexOf('// init')
    );
    expect(clearSource).toContain('surveyStore.clear');
    expect(clearSource).toContain('resetSurveyGrid');
    expect(clearSource).not.toMatch(/assessmentStates\s*=|chatHistory\s*=|caches\.|serviceWorker/);
  });

  it('keeps assessment, practice, Coach, classification, and reports outside snapshots', () => {
    const snapshotSource = source.slice(
      source.indexOf('function buildPersistableEntries'),
      source.indexOf('async function performSurveySave')
    );
    expect(snapshotSource).not.toMatch(/assessmentStates|practice|chatHistory|pendingClassification|pdf|serviceWorker|File/);
  });

  it('renders persistence status through textContent and uses an aria-live region', () => {
    expect(source).toContain('id="persistenceStatus"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('persistenceStatus.textContent =');
  });

  it('keeps blocking persistence errors intact and blocks count-save scheduling until reload', () => {
    const schedulingSource = source.slice(
      source.indexOf('function isBlockingPersistenceError'),
      source.indexOf('function cancelPendingSurveySave')
    );
    expect(schedulingSource).toContain("'revision_conflict'");
    expect(schedulingSource).toContain("'clear_not_supported'");
    expect(schedulingSource).toContain("'store_closed'");
    expect(schedulingSource).toContain('if (isBlockingPersistenceError(persistenceState.errorCode))');
    expect(schedulingSource).toContain('updatePersistenceControlState()');
    expect(schedulingSource).not.toContain("persistenceState.errorCode = 'revision_conflict'");
  });

  it('discloses partial-snapshot repair and clears it only after a successful replacement save', () => {
    expect(source).toContain('repairPending: false');
    expect(source).toContain('droppedStoredEntryCount: 0');
    expect(source).toContain('Saat perubahan berikutnya disimpan');
    expect(source).toContain('persistenceState.repairPending = result.warnings.length > 0');
    expect(source).toContain('persistenceState.repairPending = false');
    expect(source).toContain("persistenceState.statusCode = repairCount ? 'repaired' : 'saved'");
  });

  it('retains partial-repair disclosure across save failure and revision conflict paths', () => {
    const failureSource = source.slice(
      source.indexOf('function persistenceFailure'),
      source.indexOf('function buildPersistableEntries')
    );
    const messageSource = source.slice(
      source.indexOf('function persistenceMessage'),
      source.indexOf('function renderPersistenceStatus')
    );
    expect(failureSource).not.toContain('persistenceState.repairPending = false');
    expect(failureSource).not.toContain('persistenceState.droppedStoredEntryCount = 0');
    expect(messageSource).toMatch(
      /errorCode === 'revision_conflict'[\s\S]*muat ulang[\s\S]*repairDisclosure/
    );
    expect(messageSource).toMatch(
      /Perubahan belum tersimpan[\s\S]*Aplikasi tetap dapat digunakan[\s\S]*repairDisclosure/
    );
  });

  it('keeps the slot-limit notice separate from persistence status and save scheduling', () => {
    const addSource = source.slice(
      source.indexOf('function addOrganismCard'),
      source.indexOf('function chooseImageForCard')
    );
    expect(source).toContain('id="surveyNotice"');
    expect(addSource).toContain('showSurveyNotice(`Maksimal ${SurveyStore.MAX_SLOT_COUNT} slot observasi.`)');
    expect(addSource).not.toContain('persistenceState.statusCode');
    expect(addSource).not.toContain('scheduleSurveySave');
    expect(addSource).not.toContain('persistSurveyNow');
  });

  it('shows manual browser-data guidance when a stored value has no safe clear guard', () => {
    expect(source).toContain("persistenceState.errorCode === 'clear_not_supported'");
    expect(source).toContain('persistenceState.clearToken = null');
    expect(source).toContain('Hapus data situs ini melalui pengaturan browser');
    expect(source).toContain("typeof persistenceState.clearToken === 'string'");
  });
});
