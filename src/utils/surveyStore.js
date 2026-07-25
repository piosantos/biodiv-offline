(function (root, factory) {
  const dependency = typeof module === 'object' && module.exports
    ? require('./observationRecord.js')
    : root && root.ObservationRecord;
  const surveyStore = factory(dependency);

  if (typeof module === 'object' && module.exports) {
    module.exports = surveyStore;
    module.exports.default = surveyStore;
  } else if (root) {
    root.SurveyStore = surveyStore;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ObservationRecord) {
  'use strict';

  const DATABASE_NAME = 'biodiversity-survey';
  const DATABASE_VERSION = 1;
  const OBJECT_STORE_NAME = 'sessions';
  const ACTIVE_SESSION_KEY = 'active-survey';
  const SNAPSHOT_SCHEMA_VERSION = 1;
  const MAX_SLOT_COUNT = 12;

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function isValidRevision(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isValidTimestamp(value) {
    if (typeof value !== 'string' || !value) return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  }

  function createClearGuard(value) {
    const objectIds = new WeakMap();
    const ancestors = new WeakSet();
    let nextObjectId = 0;

    function encodeString(input) {
      return `${input.length}:${input}`;
    }

    function encode(input) {
      if (input === null) return 'null;';
      if (typeof input === 'boolean') return input ? 'boolean:1;' : 'boolean:0;';
      if (typeof input === 'string') return `string:${encodeString(input)};`;
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) throw new Error('unsupported_clear_guard_value');
        return Object.is(input, -0) ? 'number:-0;' : `number:${String(input)};`;
      }
      if (typeof input !== 'object') throw new Error('unsupported_clear_guard_value');
      if (ancestors.has(input)) throw new Error('unsupported_clear_guard_value');
      if (objectIds.has(input)) return `reference:${objectIds.get(input)};`;

      const prototype = Object.getPrototypeOf(input);
      const isArray = Array.isArray(input);
      if (!isArray && prototype !== Object.prototype && prototype !== null) {
        throw new Error('unsupported_clear_guard_value');
      }

      const objectId = nextObjectId;
      nextObjectId += 1;
      objectIds.set(input, objectId);
      ancestors.add(input);

      let encoded;
      if (isArray) {
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== 'string')) {
          throw new Error('unsupported_clear_guard_value');
        }
        const expectedKeys = new Set(['length']);
        for (let index = 0; index < input.length; index += 1) {
          expectedKeys.add(String(index));
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('unsupported_clear_guard_value');
          }
        }
        if (keys.some((key) => !expectedKeys.has(key))) {
          throw new Error('unsupported_clear_guard_value');
        }
        const values = [];
        for (let index = 0; index < input.length; index += 1) {
          values.push(encode(Object.getOwnPropertyDescriptor(input, String(index)).value));
        }
        encoded = `array:${objectId}:${input.length}:[${values.join('')}]`;
      } else {
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== 'string')) {
          throw new Error('unsupported_clear_guard_value');
        }
        keys.sort();
        const properties = keys.map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('unsupported_clear_guard_value');
          }
          return `${encodeString(key)}=${encode(descriptor.value)}`;
        });
        const prototypeTag = prototype === null ? 'null-prototype' : 'plain';
        encoded = `object:${prototypeTag}:${objectId}:${keys.length}:{${properties.join('')}}`;
      }

      ancestors.delete(input);
      return encoded;
    }

    try {
      return {
        supported: true,
        token: encode(value),
        reason: null
      };
    } catch {
      return {
        supported: false,
        token: null,
        reason: 'unsupported_clear_guard_value'
      };
    }
  }

  function nextRevision(value) {
    if (!isValidRevision(value)) {
      return { valid: false, revision: null, errorCode: 'invalid_revision' };
    }
    if (value === Number.MAX_SAFE_INTEGER) {
      return { valid: false, revision: null, errorCode: 'revision_overflow' };
    }
    return { valid: true, revision: value + 1, errorCode: null };
  }

  function validateEntryShape(entry, index) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, warning: { index, reason: 'invalid_observation_record' } };
    }
    if (!Number.isInteger(entry.slotIndex) || entry.slotIndex < 0 || entry.slotIndex >= MAX_SLOT_COUNT) {
      return { valid: false, warning: { index, reason: 'invalid_slot_index' } };
    }
    if (!entry.record || typeof entry.record !== 'object' || Array.isArray(entry.record)) {
      return { valid: false, warning: { index, slotIndex: entry.slotIndex, reason: 'invalid_observation_record' } };
    }
    if (entry.record.id !== entry.slotIndex) {
      return { valid: false, warning: { index, slotIndex: entry.slotIndex, reason: 'record_id_slot_mismatch' } };
    }

    const result = ObservationRecord && typeof ObservationRecord.createObservationRecord === 'function'
      ? ObservationRecord.createObservationRecord(entry.record)
      : { record: null, errors: ['observation_record_unavailable'] };
    if (!result.record) {
      return {
        valid: false,
        warning: {
          index,
          slotIndex: entry.slotIndex,
          reason: 'invalid_observation_record',
          recordErrors: Array.isArray(result.errors) ? [...result.errors] : []
        }
      };
    }

    return {
      valid: true,
      entry: {
        slotIndex: entry.slotIndex,
        record: clone(result.record)
      }
    };
  }

  function validateSnapshot(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { valid: false, errorCode: 'invalid_snapshot', snapshot: null, warnings: [] };
    }
    if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      return {
        valid: false,
        errorCode: 'unsupported_schema_version',
        snapshot: null,
        warnings: [{ reason: 'unsupported_schema_version' }]
      };
    }
    if (!isValidRevision(input.revision)) {
      return {
        valid: false,
        errorCode: 'invalid_revision',
        snapshot: null,
        warnings: [{ reason: 'invalid_revision' }]
      };
    }
    if (!isValidTimestamp(input.savedAt)) {
      return {
        valid: false,
        errorCode: 'invalid_saved_at',
        snapshot: null,
        warnings: [{ reason: 'invalid_saved_at' }]
      };
    }
    if (!Array.isArray(input.observations)) {
      return { valid: false, errorCode: 'invalid_snapshot', snapshot: null, warnings: [] };
    }
    if (input.cleared !== undefined && typeof input.cleared !== 'boolean') {
      return {
        valid: false,
        errorCode: 'invalid_clear_marker',
        snapshot: null,
        warnings: [{ reason: 'invalid_clear_marker' }]
      };
    }
    if (input.cleared === true && input.observations.length > 0) {
      return {
        valid: false,
        errorCode: 'invalid_clear_marker',
        snapshot: null,
        warnings: [{ reason: 'cleared_snapshot_has_observations' }]
      };
    }

    const slotCounts = new Map();
    input.observations.forEach((entry) => {
      if (entry && Number.isInteger(entry.slotIndex)) {
        slotCounts.set(entry.slotIndex, (slotCounts.get(entry.slotIndex) || 0) + 1);
      }
    });

    const warnings = [];
    const observations = [];
    input.observations.forEach((entry, index) => {
      if (entry && Number.isInteger(entry.slotIndex) && slotCounts.get(entry.slotIndex) > 1) {
        warnings.push({ index, slotIndex: entry.slotIndex, reason: 'duplicate_slot_index' });
        return;
      }
      const validation = validateEntryShape(entry, index);
      if (!validation.valid) {
        warnings.push(validation.warning);
        return;
      }
      observations.push(validation.entry);
    });
    observations.sort((left, right) => left.slotIndex - right.slotIndex);

    return {
      valid: true,
      errorCode: null,
      warnings,
      droppedEntryCount: warnings.length,
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        revision: input.revision,
        savedAt: input.savedAt,
        cleared: input.cleared === true,
        observations
      }
    };
  }

  function normalizeSnapshotEntries(input) {
    if (Array.isArray(input)) return input;
    if (input && Array.isArray(input.observations)) return input.observations;
    return [];
  }

  function createSnapshot(input = {}, options = {}) {
    const revision = options.revision ?? input.revision ?? 0;
    const savedAt = options.savedAt ?? input.savedAt ?? new Date().toISOString();
    const validation = validateSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      revision,
      savedAt,
      cleared: options.cleared ?? input.cleared ?? false,
      observations: normalizeSnapshotEntries(input)
    });

    return validation;
  }

  function restoreObservations(snapshot) {
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) {
      return {
        observations: [],
        entries: [],
        warnings: validation.warnings,
        errorCode: validation.errorCode
      };
    }

    const observations = [];
    validation.snapshot.observations.forEach((entry) => {
      observations[entry.slotIndex] = clone(entry.record);
    });
    return {
      observations,
      entries: clone(validation.snapshot.observations),
      warnings: clone(validation.warnings),
      errorCode: null
    };
  }

  function classifyStorageError(error, fallback = 'transaction_failed') {
    const name = error && error.name;
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota_exceeded';
    if (name === 'InvalidStateError' || name === 'NotFoundError') return fallback;
    return fallback;
  }

  function codedError(error, code) {
    const wrapped = new Error(error && error.message ? error.message : code);
    wrapped.name = error && error.name ? error.name : 'Error';
    wrapped.code = code;
    wrapped.cause = error;
    return wrapped;
  }

  function mergePersistableEntries(currentRecords, previousEntries = []) {
    const previous = new Map(
      (Array.isArray(previousEntries) ? previousEntries : [])
        .filter((entry) => entry && Number.isInteger(entry.slotIndex))
        .map((entry) => [entry.slotIndex, entry.record])
    );
    const observations = [];

    (Array.isArray(currentRecords) ? currentRecords : []).forEach((record, slotIndex) => {
      if (!record || typeof record !== 'object') return;
      const canonical = ObservationRecord && typeof ObservationRecord.createObservationRecord === 'function'
        ? ObservationRecord.createObservationRecord(record)
        : { record: null };
      if (canonical.record) {
        observations.push({ slotIndex, record: clone(canonical.record) });
        return;
      }
      if (previous.has(slotIndex)) {
        observations.push({ slotIndex, record: clone(previous.get(slotIndex)) });
      }
    });

    return observations;
  }

  function createWriteCoordinator(options = {}) {
    const delay = Number.isFinite(options.delay) && options.delay >= 0 ? options.delay : 350;
    const scheduleTimer = options.setTimeout || setTimeout;
    const cancelTimer = options.clearTimeout || clearTimeout;
    let queue = Promise.resolve();
    let timer = null;
    let scheduleGeneration = 0;
    let closed = false;

    function cancelScheduled() {
      scheduleGeneration += 1;
      if (timer !== null) {
        cancelTimer(timer);
        timer = null;
      }
    }

    function enqueue(operation) {
      if (closed) {
        return Promise.resolve({ ok: false, errorCode: 'coordinator_closed' });
      }
      const execute = () => Promise.resolve().then(operation);
      const result = queue.then(execute, execute);
      queue = result.then(() => undefined, () => undefined);
      return result;
    }

    function run(operation) {
      cancelScheduled();
      return enqueue(operation);
    }

    function schedule(operation) {
      if (closed) return false;
      cancelScheduled();
      const generation = scheduleGeneration;
      timer = scheduleTimer(() => {
        if (closed || generation !== scheduleGeneration) return;
        timer = null;
        void enqueue(operation);
      }, delay);
      return true;
    }

    function drain() {
      return queue;
    }

    function close() {
      if (closed) return queue;
      closed = true;
      cancelScheduled();
      return queue;
    }

    return {
      run,
      schedule,
      cancelScheduled,
      drain,
      close,
      hasScheduled: () => timer !== null,
      isClosed: () => closed
    };
  }

  function createStore(options = {}) {
    const indexedDB = options.indexedDB;
    const databaseName = options.databaseName || DATABASE_NAME;
    let databasePromise = null;
    let database = null;
    let closed = false;
    let currentRevision = 0;

    function structuredFailure(errorCode, error) {
      return { ok: false, errorCode, snapshot: null, warnings: [], error };
    }

    function openDatabase() {
      if (!indexedDB || typeof indexedDB.open !== 'function') {
        return Promise.reject(Object.assign(new Error('storage_unavailable'), { code: 'storage_unavailable' }));
      }
      if (closed) {
        return Promise.reject(Object.assign(new Error('store_closed'), { code: 'store_closed' }));
      }
      if (database) return Promise.resolve(database);
      if (databasePromise) return databasePromise;

      databasePromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDB.open(databaseName, DATABASE_VERSION);
        } catch (error) {
          reject(codedError(error, 'database_open_failed'));
          return;
        }
        request.onupgradeneeded = () => {
          const nextDatabase = request.result;
          if (!nextDatabase.objectStoreNames.contains(OBJECT_STORE_NAME)) {
            nextDatabase.createObjectStore(OBJECT_STORE_NAME);
          }
        };
        request.onsuccess = () => {
          const openedDatabase = request.result;
          if (closed) {
            openedDatabase.close();
            reject(codedError(null, 'store_closed'));
            return;
          }
          database = openedDatabase;
          database.onversionchange = () => {
            database.close();
            database = null;
            databasePromise = null;
          };
          resolve(database);
        };
        request.onerror = () => {
          reject(codedError(request.error, 'database_open_failed'));
        };
        request.onblocked = () => {
          reject(codedError(null, 'database_open_failed'));
        };
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });

      return databasePromise;
    }

    async function load() {
      let db;
      try {
        db = await openDatabase();
      } catch (error) {
        return structuredFailure(error.code || 'database_open_failed', error);
      }

      return new Promise((resolve) => {
        let settled = false;
        let requestResult = null;
        function finish(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }

        let transaction;
        try {
          transaction = db.transaction(OBJECT_STORE_NAME, 'readonly');
          const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
          const request = objectStore.get(ACTIVE_SESSION_KEY);
          request.onsuccess = () => {
            if (request.result === undefined) {
              const keyRequest = objectStore.getKey(ACTIVE_SESSION_KEY);
              keyRequest.onsuccess = () => {
                if (keyRequest.result === undefined) {
                  requestResult = {
                    ok: true,
                    status: 'empty',
                    snapshot: null,
                    warnings: [],
                    errorCode: null,
                    revision: 0,
                    savedAt: null,
                    tombstone: false
                  };
                  return;
                }
                requestResult = {
                  ok: false,
                  status: 'invalid',
                  snapshot: null,
                  warnings: [],
                  errorCode: 'clear_not_supported',
                  snapshotErrorCode: 'invalid_snapshot',
                  clearToken: null,
                  clearGuardReason: 'unsupported_clear_guard_value'
                };
              };
              keyRequest.onerror = () => finish(structuredFailure(
                classifyStorageError(keyRequest.error),
                keyRequest.error
              ));
              return;
            }
            const validation = validateSnapshot(request.result);
            if (!validation.valid) {
              const clearGuard = createClearGuard(request.result);
              requestResult = {
                ok: false,
                status: 'invalid',
                snapshot: null,
                warnings: validation.warnings,
                errorCode: clearGuard.supported ? validation.errorCode : 'clear_not_supported',
                snapshotErrorCode: validation.errorCode,
                clearToken: clearGuard.token,
                clearGuardReason: clearGuard.reason
              };
              return;
            }
            if (validation.snapshot.cleared) {
              requestResult = {
                ok: true,
                status: 'empty',
                snapshot: null,
                warnings: [],
                errorCode: null,
                revision: validation.snapshot.revision,
                savedAt: validation.snapshot.savedAt,
                tombstone: true
              };
              return;
            }
            requestResult = {
              ok: true,
              status: validation.warnings.length ? 'partial' : 'loaded',
              snapshot: clone(validation.snapshot),
              warnings: clone(validation.warnings),
              errorCode: validation.warnings.length ? 'corrupt_snapshot' : null,
              droppedEntryCount: validation.warnings.length,
              revision: validation.snapshot.revision,
              savedAt: validation.snapshot.savedAt,
              tombstone: false
            };
          };
          request.onerror = () => finish(structuredFailure(
            classifyStorageError(request.error),
            request.error
          ));
          transaction.onerror = () => finish(structuredFailure(
            classifyStorageError(transaction.error),
            transaction.error
          ));
          transaction.onabort = () => finish(structuredFailure(
            classifyStorageError(transaction.error),
            transaction.error
          ));
          transaction.oncomplete = () => {
            if (!requestResult) {
              finish(structuredFailure('transaction_failed'));
              return;
            }
            if (requestResult.ok) currentRevision = requestResult.revision;
            finish(requestResult);
          };
        } catch (error) {
          finish(structuredFailure(classifyStorageError(error), error));
        }
      });
    }

    async function save(snapshotInput, saveOptions = {}) {
      let db;
      try {
        db = await openDatabase();
      } catch (error) {
        return structuredFailure(error.code || 'database_open_failed', error);
      }

      const expectedRevision = saveOptions.expectedRevision ?? currentRevision;
      if (!isValidRevision(expectedRevision)) {
        return structuredFailure('invalid_revision');
      }
      const revisionResult = nextRevision(expectedRevision);
      if (!revisionResult.valid) {
        return structuredFailure(revisionResult.errorCode);
      }
      const prepared = createSnapshot(snapshotInput, {
        revision: revisionResult.revision,
        savedAt: saveOptions.savedAt || new Date().toISOString()
      });
      if (!prepared.valid) {
        return {
          ok: false,
          errorCode: prepared.errorCode || 'invalid_snapshot',
          snapshot: null,
          warnings: prepared.warnings
        };
      }
      if (prepared.warnings.length) {
        return {
          ok: false,
          errorCode: 'invalid_snapshot',
          snapshot: null,
          warnings: prepared.warnings
        };
      }
      const snapshot = clone(prepared.snapshot);

      return new Promise((resolve) => {
        let settled = false;
        let conflict = null;
        function finish(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }

        let transaction;
        try {
          transaction = db.transaction(OBJECT_STORE_NAME, 'readwrite');
          const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
          const getRequest = objectStore.get(ACTIVE_SESSION_KEY);
          getRequest.onsuccess = () => {
            const storedRevision = getRequest.result && isValidRevision(getRequest.result.revision)
              ? getRequest.result.revision
              : 0;
            if (storedRevision !== expectedRevision) {
              conflict = { expectedRevision, storedRevision };
              transaction.abort();
              return;
            }
            objectStore.put(snapshot, ACTIVE_SESSION_KEY);
          };
          getRequest.onerror = () => transaction.abort();
          transaction.oncomplete = () => {
            currentRevision = revisionResult.revision;
            finish({
              ok: true,
              errorCode: null,
              snapshot: clone(snapshot),
              warnings: clone(prepared.warnings)
            });
          };
          transaction.onabort = () => {
            if (conflict) {
              finish({
                ok: false,
                errorCode: 'revision_conflict',
                snapshot: null,
                warnings: [],
                conflict
              });
              return;
            }
            finish(structuredFailure(classifyStorageError(transaction.error), transaction.error));
          };
          transaction.onerror = () => {
            if (!conflict) {
              finish(structuredFailure(classifyStorageError(transaction.error), transaction.error));
            }
          };
        } catch (error) {
          finish(structuredFailure(classifyStorageError(error), error));
        }
      });
    }

    async function clear(clearOptions = {}) {
      const expectedRevision = clearOptions.expectedRevision ?? currentRevision;
      if (!isValidRevision(expectedRevision)) {
        return structuredFailure('invalid_revision');
      }
      if (clearOptions.savedAt !== undefined && !isValidTimestamp(clearOptions.savedAt)) {
        return structuredFailure('invalid_saved_at');
      }

      let db;
      try {
        db = await openDatabase();
      } catch (error) {
        return structuredFailure(error.code || 'database_open_failed', error);
      }
      return new Promise((resolve) => {
        let settled = false;
        let conflict = null;
        let deterministicError = null;
        let tombstone = null;
        function finish(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }

        try {
          const transaction = db.transaction(OBJECT_STORE_NAME, 'readwrite');
          const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
          const getRequest = objectStore.get(ACTIVE_SESSION_KEY);
          getRequest.onsuccess = () => {
            const currentClearGuard = createClearGuard(getRequest.result);
            const hasValidStoredRevision = getRequest.result
              && isValidRevision(getRequest.result.revision);
            const storedRevision = hasValidStoredRevision
              ? getRequest.result.revision
              : 0;
            if (!clearOptions.force && storedRevision !== expectedRevision) {
              conflict = { expectedRevision, storedRevision };
              transaction.abort();
              return;
            }
            if (clearOptions.force && !currentClearGuard.supported) {
              deterministicError = 'clear_not_supported';
              transaction.abort();
              return;
            }
            if (clearOptions.force && (
              typeof clearOptions.clearToken !== 'string'
              || currentClearGuard.token !== clearOptions.clearToken
            )) {
              conflict = { expectedRevision, storedRevision, reason: 'stored_value_changed' };
              transaction.abort();
              return;
            }
            const baseRevision = clearOptions.force && hasValidStoredRevision
              ? storedRevision
              : expectedRevision;
            const revisionResult = nextRevision(baseRevision);
            if (!revisionResult.valid) {
              deterministicError = revisionResult.errorCode;
              transaction.abort();
              return;
            }
            const prepared = createSnapshot({ observations: [] }, {
              revision: revisionResult.revision,
              savedAt: clearOptions.savedAt || new Date().toISOString(),
              cleared: true
            });
            if (!prepared.valid) {
              deterministicError = prepared.errorCode || 'invalid_snapshot';
              transaction.abort();
              return;
            }
            tombstone = prepared.snapshot;
            objectStore.put(clone(tombstone), ACTIVE_SESSION_KEY);
          };
          getRequest.onerror = () => transaction.abort();
          transaction.oncomplete = () => {
            currentRevision = tombstone.revision;
            finish({
              ok: true,
              errorCode: null,
              snapshot: null,
              warnings: [],
              revision: tombstone.revision,
              savedAt: tombstone.savedAt,
              tombstone: true
            });
          };
          transaction.onabort = () => {
            if (deterministicError) {
              finish(structuredFailure(deterministicError));
              return;
            }
            if (conflict) {
              finish({
                ok: false,
                errorCode: 'revision_conflict',
                snapshot: null,
                warnings: [],
                conflict
              });
              return;
            }
            finish(structuredFailure(classifyStorageError(transaction.error), transaction.error));
          };
          transaction.onerror = () => {
            if (!conflict) finish(structuredFailure(classifyStorageError(transaction.error), transaction.error));
          };
        } catch (error) {
          finish(structuredFailure(classifyStorageError(error), error));
        }
      });
    }

    function close() {
      if (closed) return;
      closed = true;
      if (database) database.close();
      database = null;
      databasePromise = null;
    }

    return {
      load,
      save,
      clear,
      close
    };
  }

  return {
    DATABASE_NAME,
    DATABASE_VERSION,
    OBJECT_STORE_NAME,
    ACTIVE_SESSION_KEY,
    SNAPSHOT_SCHEMA_VERSION,
    MAX_SLOT_COUNT,
    createClearGuard,
    isValidRevision,
    createSnapshot,
    validateSnapshot,
    restoreObservations,
    mergePersistableEntries,
    createWriteCoordinator,
    createStore
  };
});
