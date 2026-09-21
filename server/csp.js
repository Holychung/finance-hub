'use strict';

// The Content-Security-Policy, in one place, because there are two of them.
//
// The local server is a server: the page has to reach `/api` on its own
// origin, so `connect-src 'self'`. The hosted demo reaches nothing at all —
// every route is answered from a Map in the tab — so it ships
// `connect-src 'none'` and the page becomes *incapable* of sending anything
// anywhere. That is the strongest available version of this project's central
// claim, and unlike a privacy policy a visitor can confirm it in the network
// tab or in the response headers.
//
// One definition rather than two because the difference between them has to
// stay exactly one directive wide. A second copy in `scripts/pack-demo.js`
// would drift on the first change here, and it would drift silently — the
// only thing that notices a weakened CSP is somebody reading it.
//
// `default-src 'none'` is what makes the rest of the list exhaustive: the
// page fetches nothing that is not named. `style-src` admits 'unsafe-inline'
// because the views still write inline `style=` attributes; that costs little
// while every scheme an inline `url()` could reach is already 'none' or
// 'self', and it is a reason to finish moving them into the stylesheet rather
// than to keep a header honest.

const directives = (connect) => [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",       // the favicon is a data: URI
  `connect-src ${connect}`,
  "form-action 'none'",         // nothing is submitted as a form; it is all fetch
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

// The `<meta http-equiv>` form is not the header form: the HTML spec has the
// parser ignore `frame-ancestors` (also `report-uri` and `sandbox`) there, so
// a page whose only CSP is a meta tag cannot refuse to be framed. Dropping it
// here rather than emitting a directive the browser will discard, because a
// policy that lists a protection it is not applying is worse than one that
// does not claim it.
const META_ONLY_IGNORES = ['frame-ancestors'];

const csp = (connect) => directives(connect).join('; ');

const cspMeta = (connect) => directives(connect)
  .filter((d) => !META_ONLY_IGNORES.some((name) => d.startsWith(`${name} `)))
  .join('; ');

module.exports = {
  csp,
  cspMeta,
  META_ONLY_IGNORES,
  // Named rather than passed as string literals at the call sites, so
  // `grep -rn HOSTED` finds every place the tighter one is used.
  LOCAL: "'self'",
  HOSTED: "'none'",
};
