(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const sanitizeLabel = factory();
    module.exports = sanitizeLabel;
    module.exports.default = sanitizeLabel;
    module.exports.sanitizeLabel = sanitizeLabel;
  } else {
    root.sanitizeLabel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const replacements = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  });

  function sanitizeLabel(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => replacements[char] || char);
  }

  return sanitizeLabel;
});
