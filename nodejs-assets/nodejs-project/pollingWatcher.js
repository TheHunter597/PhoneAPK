/**
 * pollingWatcher.js — minimal chokidar-compatible watcher that uses fs
 * polling instead of native fs events. Required because chokidar's default
 * backend on Linux/Android uses inotify, which works, but pulls in fsevents
 * (macOS-only) and a native binding that nodejs-mobile cannot easily ship.
 *
 * Exposes the same .on(eventName, handler) and .close() surface that the
 * existing watcher code expects, so we can swap chokidar out without touching
 * the rest of each watcher's logic.
 *
 * API surface (subset of chokidar):
 *   const w = new PollingWatcher(root, options);
 *   w.on('add',     (path) => {})
 *    .on('change',  (path) => {})
 *    .on('unlink',  (path) => {})
 *    .on('addDir',  (path) => {})
 *    .on('unlinkDir',(path) => {})
 *    .on('error',   (err) => {});
 *   w.close();
 *
 * Options:
 *   - interval       (ms, default 2000)   how often to rescan
 *   - ignored        (array of glob strings, default [])  paths whose absolute
 *                    path matches any pattern (via minimatch-style *) are skipped
 *   - ignoreInitial  (bool, default true)  don't fire 'add' for files present
 *                    at startup (matches chokidar semantics used by our watchers)
 */

const fs = require('fs');
const path = require('path');

function minimatchLite(filePath, pattern) {
  // Convert a single glob pattern to a RegExp. Supports:
  //   **  → any path segment sequence (incl. '/')
  //   *   → any chars except '/'
  //   ?   → any single char except '/'
  //   .   → literal '.'
  // Everything else is escaped.
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**'
        i++;
        if (pattern[i + 1] === '/') i++; // swallow trailing '/'
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '.') {
      re += '\\.';
    } else if ('\\+()|^$[]{}-'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re).test(filePath);
}

class PollingWatcher {
  constructor(root, options = {}) {
    this.root = root;
    this.interval = options.interval || 2000;
    this.ignored = options.ignored || [];
    this.ignoreInitial = options.ignoreInitial !== false;
    this._handlers = {
      add: [], change: [], unlink: [],
      addDir: [], unlinkDir: [], error: [],
    };
    this._timer = null;
    this._snapshot = new Map(); // absPath → mtimeMs
    this._started = false;
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  _emit(event, payload) {
    const hs = this._handlers[event] || [];
    for (const h of hs) {
      try { h(payload); } catch (err) {
        (this._handlers.error || []).forEach((eh) => eh(err));
      }
    }
  }

  _isIgnored(absPath) {
    if (!this.ignored || this.ignored.length === 0) return false;
    for (const pat of this.ignored) {
      if (minimatchLite(absPath, pat)) return true;
    }
    return false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    // Initial scan — emit 'add' / 'addDir' for everything found, UNLESS
    // ignoreInitial is true (the default for our chokidar usage).
    this._scan(true);
    this._timer = setInterval(() => this._scan(false), this.interval);
  }

  _scan(isInitial) {
    const walk = (dir) => {
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return; // dir might have been deleted mid-scan
      }
      for (const item of items) {
        // Skip dotfiles/dotfolders entirely (.git, .obsidian, etc.).
        if (item.name.startsWith('.')) continue;
        const abs = path.join(dir, item.name);
        if (this._isIgnored(abs)) continue;
        if (item.isDirectory()) {
          if (!this._snapshot.has(abs)) {
            this._snapshot.set(abs, -1); // dir sentinel
            if (!isInitial || !this.ignoreInitial) this._emit('addDir', abs);
          }
          walk(abs);
        } else if (item.isFile()) {
          let stat;
          try { stat = fs.statSync(abs); } catch { continue; }
          const mtime = stat.mtimeMs;
          if (!this._snapshot.has(abs)) {
            if (!isInitial || !this.ignoreInitial) this._emit('add', abs);
          } else if (this._snapshot.get(abs) !== mtime) {
            if (!isInitial) this._emit('change', abs);
          }
          this._snapshot.set(abs, mtime);
        }
      }
    };

    try {
      walk(this.root);
    } catch (err) {
      this._emit('error', err);
      return;
    }

    // Detect deletions: any path in the snapshot that wasn't seen this pass.
    // (We can't track "seen" efficiently, so we re-scan and compare. The
    // snapshot Map is the source of truth — if a path is still there, we
    // updated its mtime above; if it wasn't visited, it's gone.)
    // To detect this, we mark entries during the walk.
    const seen = new Set();
    {
      const walkMark = (dir) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          if (item.name.startsWith('.')) continue;
          const abs = path.join(dir, item.name);
          seen.add(abs);
          if (item.isDirectory()) walkMark(abs);
        }
      };
      walkMark(this.root);
    }
    for (const abs of this._snapshot.keys()) {
      if (!seen.has(abs)) {
        const wasDir = this._snapshot.get(abs) === -1;
        this._snapshot.delete(abs);
        if (!isInitial) {
          this._emit(wasDir ? 'unlinkDir' : 'unlink', abs);
        }
      }
    }
  }

  close() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._started = false;
    this._snapshot.clear();
  }
}

module.exports = PollingWatcher;
module.exports.watch = function (root, options) {
  const w = new PollingWatcher(root, options);
  w.start();
  return w;
};
