'use strict';

// Where the app meets its storage.
//
// Everything the UI knows about where the ledger lives goes through this
// object — there is no `fetch` anywhere else in `web/`, and no view builds an
// export URL of its own. That was already almost true: one `fetch()` in
// `core.js` plus six `<a href="/api/export/...">` scattered across three
// views. The six are the interesting half, because a storage backend with no
// server behind it would have left them pointing at nothing, and you find
// that kind of thing one dead button at a time.
//
// **The contract.** An adapter provides exactly this:
//
//   name                  what to call it in the UI when it is not the ledger
//   get(path)             -> parsed JSON, throws Error(message) on failure
//   post(path, body)      -> same, body is a plain object
//   put(path, body)       -> same
//   del(path)             -> same
//   exportHref(path)      -> a URL an <a download> can point at
//
// `path` is always an `/api/...` string. That is a deliberate choice and not
// laziness: the routes are the vocabulary the views already speak, they are
// documented and tested, and an adapter that answers them is a drop-in. A
// second adapter is expected to route on the path rather than to serve it.
//
// `get` is async and must stay async even where an implementation could
// answer immediately — every call site awaits, and a promise that resolves
// synchronously in one adapter and not the other is the kind of difference
// that only shows up as a render-order bug.
//
// This is the HTTP one, and it does exactly what the code it replaced did.

// A factory rather than an object, because `web/storage.js` is the one file
// that gets to declare `storage` — two files declaring it at top level in the
// shared script scope is a SyntaxError and a blank page.
function createHttpStorage() {
  return {
    name: 'http',

    async get(path) {
      return request(path, {});
    },

    post(path, body) {
      return request(path, { method: 'POST', body: JSON.stringify(body) });
    },

    put(path, body) {
      return request(path, { method: 'PUT', body: JSON.stringify(body) });
    },

    del(path) {
      return request(path, { method: 'DELETE' });
    },

    // A real URL on this origin, served by `exportCsv` with a
    // Content-Disposition. Nothing to build and nothing to revoke — an
    // adapter with no server hands back a `blob:` URL here instead, which an
    // `<a download>` takes just as happily.
    exportHref(path) {
      return path;
    },

    // The server already named the file, down to the date stamp, so there is
    // nothing for the link to override. An adapter handing back a `blob:`
    // URL has to supply one, because a blob carries no name.
    exportName() {
      return null;
    },
  };
}

// The only fetch() in the frontend. `Content-Type: application/json` is not
// decoration: the server refuses a non-GET body without it, which is the
// guard that stops a cross-site form POST from reaching the ledger.
async function request(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
