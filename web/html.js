'use strict';

// Escaping by default.
//
// The previous approach was a plain template literal plus a remembered esc()
// around every interpolation. That is correct exactly as long as nobody ever
// forgets, and a single miss is a hole. Here an interpolated value is escaped
// unless it is itself markup this module produced, so the safe thing is what
// happens when you do nothing.
//
// Html extends String on purpose: if a call site leaves a stray .join('') in
// place, the result collapses to a plain string and gets escaped, so the
// mistake shows up as visible tags on screen rather than as an injection.

(function (root) {
  class Html extends String {}

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  function fmt(v) {
    if (v === null || v === undefined || v === false || v === true) return '';
    if (v instanceof Html) return String(v);
    if (Array.isArray(v)) return v.map(fmt).join('');
    return esc(v);
  }

  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += fmt(values[i]) + strings[i + 1];
    return new Html(out);
  }

  // Explicit opt-out, for the rare case of markup from somewhere else.
  // Every use should be obvious at the call site and justified in a comment.
  const raw = (s) => new Html(String(s));

  // The only sanctioned way to put a template into the document.
  const mount = (el, tpl) => { el.innerHTML = fmt(tpl); };

  const api = { Html, html, raw, fmt, esc, mount };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
