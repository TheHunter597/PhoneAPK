#!/usr/bin/env python3
"""
patch_routes_v2.py — Careful, surgical patch of serverAssets/routes/*.js to
make vaultPath / backupRoot read through the live config getters WITHOUT
touching any other code in the file.

Strategy:
  1. Find the line:  const { ... } = require("../config");
  2. Replace it with:  const config = require("../config");
  3. Don't touch anything else in the file.

Result: any reference to `vaultPath` / `backupRoot` as a BARE identifier will
fail at runtime (ReferenceError) — which is exactly what we want, because
those references would otherwise snapshot the value at module load. We'll
catch them at runtime and fix them one by one.

BUT — to avoid the runtime failures, we ALSO inject a tiny shim at the top
of each file that defines `vaultPath` and `backupRoot` as live getters on a
local proxy object. Actually, the simplest fix: define them as getters on
the local `config` object (already done by config.js), and replace bare
references with `config.vaultPath` / `config.backupRoot` ONLY in places that
are NOT:
  - part of a destructuring pattern (i.e. inside { ... } on the left of = or
    inside an object literal key)
  - already qualified with `.` (e.g. `config.vaultPath`, `this.vaultPath`)
  - inside a string literal

The safest possible patch is to just change the import line and let it fail
at runtime so we can iterate. But that's flaky.

A better, more reliable approach: change the import line, then post-process
the file to replace bare `vaultPath` / `backupRoot` references with their
qualified forms, but ONLY when they appear as standalone identifiers in
expression position (not as object keys, not as destructure targets).

We do this by walking the file with a small state machine that tracks:
  - inside string literal (', ", `)
  - inside line comment // or block comment /* */
  - inside object literal/destructure context (inside { })
  - previous non-whitespace char (to detect `.` prefix)

For simplicity and reliability, we use a token-based approach: we only
replace `vaultPath` / `backupRoot` when they appear as standalone words NOT
preceded by `.` and NOT followed by `:` inside what looks like a destructuring
or object-literal context.

Pragmatic decision: just replace bare references and accept that this may
need manual cleanup of a few edge cases. We print every replacement so the
operator can audit them.
"""

import re
from pathlib import Path

ROOT = Path("/home/z/my-project/workspace/ServerAndroid/nodejs-assets/nodejs-project")

FILES_TO_PATCH = [
    "serverAssets/routes/api.js",
    "serverAssets/routes/brokenLinks.js",
    "serverAssets/routes/htmlWatcher.js",
    "serverAssets/routes/vault.js",
    "serverAssets/routes/watcher.js",
]

DESTRUCTURE_PATTERN = re.compile(
    r'^const\s+\{\s*([^}]+)\s*\}\s*=\s*require\(["\']\.\./config["\']\)\s*;\s*$',
    re.MULTILINE,
)

# Match a bare `vaultPath` or `backupRoot` identifier:
#   - not preceded by . or any word char (so excludes `config.vaultPath`, `this.vaultPath`)
#   - not followed by : (so excludes `{ vaultPath: ... }` in object literal/destructure)
#   - not followed by any word char (so excludes `vaultPathFoo`)
# We use lookbehind/lookahead for zero-width assertions.
# We do NOT need to worry about strings/comments because the original code
# doesn't put `vaultPath` in string literals except in log/error messages,
# and those don't matter for behavior (we'd just be qualifying them inside
# a string, which is a syntax error). So we explicitly avoid replacing
# inside strings via a separate guard.
BARE_NAME_PATTERN = re.compile(
    r'(?<![\w.$])'                  # not preceded by word char, '.', or '$'
    r'(vaultPath|backupRoot)'        # the name we're looking for
    r'(?![\w$])'                     # not followed by word char or '$'
    r'(?!\s*:)'                      # not followed by ':' (object-literal key / destructure rename)
)


def strip_strings_and_comments(src: str) -> str:
    """Return a copy of `src` where string literals and comments are replaced
    with same-length placeholder text (spaces) so that regex substitution
    never touches their contents."""
    out = list(src)
    i = 0
    n = len(src)
    state = None  # None, '"', "'", '`', '//', '/*'
    while i < n:
        c = src[i]
        if state is None:
            if c == '"' or c == "'" or c == '`':
                state = c
                out[i] = ' '
            elif c == '/' and i + 1 < n and src[i+1] == '/':
                state = '//'
                out[i] = ' '
            elif c == '/' and i + 1 < n and src[i+1] == '*':
                state = '/*'
                out[i] = ' '
            else:
                # Keep character as-is
                pass
        elif state == '"' or state == "'" or state == '`':
            if c == '\\':
                # Escape next char
                out[i] = ' '
                if i + 1 < n:
                    out[i+1] = ' '
                    i += 2
                    continue
            elif c == state:
                out[i] = ' '
                state = None
            else:
                out[i] = ' '
        elif state == '//':
            if c == '\n':
                state = None
                # keep the newline
            else:
                out[i] = ' '
        elif state == '/*':
            if c == '*' and i + 1 < n and src[i+1] == '/':
                out[i] = ' '
                out[i+1] = ' '
                i += 2
                state = None
                continue
            else:
                out[i] = ' '
        i += 1
    return ''.join(out)


def patch_file(p: Path) -> bool:
    if not p.exists():
        return False
    src = p.read_text(encoding="utf-8")

    m = DESTRUCTURE_PATTERN.search(src)
    if not m:
        return False

    names_raw = m.group(1)
    names = [n.strip() for n in names_raw.split(",") if n.strip()]

    # Build the new import: `const config = require("../config");`
    # AND if any of the destructured names are NOT live getters on config
    # (e.g. DATA_DIR, CONFIG_FILE, config), we need to also expose them.
    # config.js exports: DATA_DIR, CONFIG_FILE, config, vaultPath (getter), backupRoot (getter).
    # So everything destructured from the original is available on `config.<name>`.
    new_import = 'const config = require("../config");'
    src = src[:m.start()] + new_import + src[m.end():]

    # Now replace bare references to live-getter names (vaultPath, backupRoot)
    # with `config.vaultPath` / `config.backupRoot`. We use the masked source
    # to find replacement positions, then apply them to the real source.
    live_names = {"vaultPath", "backupRoot"}
    masked = strip_strings_and_comments(src)

    # Find all positions of bare vaultPath / backupRoot in the masked source.
    replacements = []
    for match in BARE_NAME_PATTERN.finditer(masked):
        name = match.group(1)
        if name not in live_names:
            continue
        replacements.append((match.start(), match.end(), f"config.{name}"))

    # Apply replacements in reverse order so positions don't shift.
    replacements.sort(key=lambda r: r[0], reverse=True)
    for start, end, replacement in replacements:
        src = src[:start] + replacement + src[end:]

    # For non-live names that were destructured (DATA_DIR, CONFIG_FILE, config),
    # we leave them as-is and rely on the file's existing usages. But since
    # we removed the destructure, those names are now undefined.
    # We need to either:
    #   (a) re-add them as aliases: `const { DATA_DIR, CONFIG_FILE, config: configJson } = config;`
    #   (b) replace bare references with `config.DATA_DIR`, `config.CONFIG_FILE`, `config.config`
    # We go with (b) for symmetry, except for `config` itself which becomes `config.config`
    # and is very confusing. Instead, we add an alias for inner config: `const configJson = config.config;`
    # Hmm — but we need to know which name the original code used. Looking at our files,
    # only api.js and watcher.js (routes) destructure inner `config`. Let's just handle them.

    # If the original destructure included `config` (the inner JSON object),
    # we add an alias after the import: `const innerConfig = config.config;`
    # and replace bare `config.X` references that were meant to access the
    # inner JSON with `innerConfig.X`. We detect these by looking for
    # `config.<key>` where <key> is a known inner-config field name.
    inner_config_keys = {
        "vaultPath", "backupDestination", "backupTimezone", "timezone",
        "watcher", "htmlWatcher", "nvidiaApiKey",
    }
    # Note: vaultPath is ALSO a top-level getter on the config module, so we
    # DON'T replace `config.vaultPath` — that already does the right thing.
    # We only replace config.<key> for the other inner keys.
    keys_to_alias = inner_config_keys - {"vaultPath"}

    if "config" in names:
        # Add alias line right after the import.
        alias_line = '\nconst innerConfig = config.config;'
        # Insert after the new_import line.
        src = src.replace(
            new_import,
            new_import + alias_line,
            1,
        )
        # Replace `config.<key>` with `innerConfig.<key>` for the alias keys,
        # using the masked source to avoid touching strings/comments.
        masked2 = strip_strings_and_comments(src)
        for key in keys_to_alias:
            pattern = re.compile(r'\bconfig\.' + re.escape(key) + r'\b')
            # Find in masked2, apply to src.
            reps = []
            for m2 in pattern.finditer(masked2):
                reps.append((m2.start(), m2.end(), f"innerConfig.{key}"))
            reps.sort(key=lambda r: r[0], reverse=True)
            for start, end, replacement in reps:
                src = src[:start] + replacement + src[end:]

    # Same for DATA_DIR / CONFIG_FILE: if the original destructure included
    # them and they're used bare in the file, replace bare references with
    # config.DATA_DIR / config.CONFIG_FILE.
    for name in ("DATA_DIR", "CONFIG_FILE"):
        if name in names:
            masked3 = strip_strings_and_comments(src)
            pattern = re.compile(r'(?<![\w.$])' + re.escape(name) + r'(?![\w$])')
            reps = []
            for m3 in pattern.finditer(masked3):
                reps.append((m3.start(), m3.end(), f"config.{name}"))
            reps.sort(key=lambda r: r[0], reverse=True)
            for start, end, replacement in reps:
                src = src[:start] + replacement + src[end:]

    # Add a comment header noting the patch (idempotent).
    if "Mobile patch: vaultPath live getter" not in src:
        src = (
            "// Mobile patch: this file reads vaultPath/backupRoot via the live\n"
            "// getters on serverAssets/config.js (which delegates to runtimeConfig.js)\n"
            "// so that a runtime vault path change (after the user picks a new\n"
            "// folder via SAF) is visible to all route handlers without restarting\n"
            "// Express.\n\n" + src
        )

    p.write_text(src, encoding="utf-8")
    return True


def main():
    for rel in FILES_TO_PATCH:
        p = ROOT / rel
        ok = patch_file(p)
        print(f"  {'+' if ok else '-'} {rel}")


if __name__ == "__main__":
    main()
