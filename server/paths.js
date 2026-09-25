'use strict';

// Where the ledger lives. Pure path resolution, no side effects: nothing here
// creates a directory or opens a database. That is what lets a caller decide
// *which* book it is about to touch and refuse before `./db` is required —
// requiring that creates and migrates whatever DB_PATH resolves to.
// `scripts/seed-demo.js` is the one that depends on it today, to refuse the
// personal ledger without having opened it.

const path = require('node:path');
const os = require('node:os');

// The ledger does not live in the repository. A repo is cloned, cleaned,
// branched, worktree'd and thrown away; `git clean -xdf` deletes an ignored
// data/ without asking, taking data/backups/ with it, and every new worktree
// would otherwise start against an empty database that reads as data loss.
// Years of transactions need a home whose lifetime is not the checkout's.
const HOME_DIR = path.join(os.homedir(), '.finance-hub');

// A profile is a separate ledger under that home: `personal` is the real book,
// anything else is a demo or a scratch one. It becomes a filename, so it may
// not be a path.
const PROFILE = process.env.FINANCE_PROFILE || 'personal';
if (!/^[A-Za-z0-9_-]{1,32}$/.test(PROFILE)) {
  throw new Error(`FINANCE_PROFILE 只能是英數字、底線或減號，長度 1-32（收到「${PROFILE}」）`);
}

const IS_PERSONAL = PROFILE === 'personal';
const DB_PATH =
  process.env.FINANCE_DB || path.join(HOME_DIR, IS_PERSONAL ? 'finance.db' : `${PROFILE}.db`);

// Derived from the database rather than fixed, so an explicit FINANCE_DB keeps
// its backups beside itself and nothing is ever written inside the repo.
const DATA_DIR = path.dirname(DB_PATH);

// **One directory per book, named after the book — including the personal
// one.** Every profile shares a DATA_DIR, so they used to share `backups/`
// too, and that is worse than untidy on two counts:
//
//   - `pruneBackups()` keeps the newest KEEP_BACKUPS files *in the directory*.
//     A few imports into a demo book would therefore delete the personal
//     ledger's snapshots — the backups nobody notices are missing until the
//     day they are needed.
//   - Snapshots are named for when they were taken, never for which book they
//     came from, so a demo's and the real one's sat side by side looking
//     identical. Restoring the wrong one overwrites real accounts with
//     invented ones.
//
// `backups/personal/` rather than leaving the real book in the bare
// `backups/`: one rule with no exception, and a folder you can open and know
// what is in it without reading any code. Nothing migrates snapshots written
// by an earlier layout — this is pre-1.0 and the shape of things still moves;
// carrying a one-time file move forever to spare a `mv` costs more than it
// saves.
//
// The filenames inside are deliberately unchanged. `pruneBackups()` sorts by
// name in order to sort by time, so a per-profile prefix would let 'd' before
// 'p' outrank the timestamp and delete the wrong file first — and inside a
// directory holding one book, the name has nothing left to disambiguate.
const BACKUP_DIR = path.join(DATA_DIR, 'backups', PROFILE);

// The AI providers' keys, for AI 健檢 (server/ai.js). Beside the book rather
// than in it, because a key is not ledger data: every snapshot is a copy of
// the database, and a key stored there would ride along into every backup
// and every file somebody is handed to debug an import. One file for every
// profile in the directory, because the key is the person's, not the book's.
const AI_KEYS_PATH = path.join(DATA_DIR, 'ai-keys.json');

module.exports = { HOME_DIR, PROFILE, IS_PERSONAL, DB_PATH, DATA_DIR, BACKUP_DIR, AI_KEYS_PATH };
