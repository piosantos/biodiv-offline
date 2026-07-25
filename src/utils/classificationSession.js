(function (root, factory) {
  const classificationSession = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = classificationSession;
    module.exports.default = classificationSession;
  } else {
    root.ClassificationSession = classificationSession;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function snapshotRequest(request) {
    if (!request) return null;
    return Object.freeze({
      id: request.id,
      cardIndex: request.cardIndex,
      fileName: request.fileName
    });
  }

  function validContext(context) {
    return Boolean(
      context
      && typeof context === 'object'
      && !Array.isArray(context)
      && Number.isInteger(context.cardIndex)
      && context.cardIndex >= 0
      && typeof context.fileName === 'string'
      && context.fileName.trim()
    );
  }

  function createController() {
    let nextRequestId = 1;
    let activeRequest = null;

    function begin(context) {
      if (!validContext(context)) return null;

      activeRequest = {
        id: nextRequestId,
        cardIndex: context.cardIndex,
        fileName: context.fileName
      };
      nextRequestId += 1;
      return snapshotRequest(activeRequest);
    }

    function isActive(requestId) {
      return Boolean(activeRequest && activeRequest.id === requestId);
    }

    function complete(requestId) {
      if (!isActive(requestId)) return false;
      activeRequest = null;
      return true;
    }

    function invalidate(requestId) {
      if (!isActive(requestId)) return false;
      activeRequest = null;
      return true;
    }

    function getActive() {
      return snapshotRequest(activeRequest);
    }

    return Object.freeze({
      begin,
      complete,
      getActive,
      invalidate,
      isActive
    });
  }

  return Object.freeze({ createController });
});
