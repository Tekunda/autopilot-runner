// Extracts the DEPENDENCY DECLARATIONS out of a Python manifest, and nothing else.
//
// THE BUG THIS FILE EXISTS TO END. The first cut of the declared-tool rule searched the whole of
// `pyproject.toml` for a distribution name, with only lines starting `[` removed. Measured, that
// meant all four of these declared a tool the repo does not use:
//
//     # "mypy>=1.0",  # TODO: turn this back on      -> declares mypy (a COMMENT)
//     description = "Static analysis without mypy"   -> declares mypy (PROSE)
//     classifiers = ["Framework :: Pytest"]          -> declares pytest (a TROVE CLASSIFIER)
//     [project.urls]                                 -> declares ruff (a URL)
//     Linting = "https://docs.astral.sh/ruff/"
//
// That is not a cosmetic false positive. A commented-out dev dependency makes the gate bootstrap,
// probe, find the tool absent, and return a BLOCKING `unjudged`/`infra` that escalates to a human
// and that no edit to the diff can clear -- the same unfixable red the declared-tool rule exists to
// prevent, arrived at from the other side.
//
// So: comments are stripped respecting string state, and the search happens ONLY inside the
// containers a dependency can actually live in. Anything this file cannot parse contributes
// nothing, which reads downstream as "not declared" -- a benign skip, never a pass and never an
// unfixable red.
//
// Still a deliberately small sniff, not a TOML parser: a real one is a runtime dependency this repo
// does not have (stack-profile.ts's `pyprojectManager` set the same discipline). Every rule keys off
// a line-anchored table header or a `key = [...]` array, both unambiguous in valid TOML.

// A container a PEP 508 requirement string can legitimately appear in.
//   [project] dependencies / optional-dependencies    - PEP 621
//   [dependency-groups]                               - PEP 735
//   [tool.poetry(.group.*).dependencies]              - poetry, where the KEY is the name
//   [project.optional-dependencies] <extra> = [...]   - the dev extra the bootstrap installs
const PEP621_ARRAY_KEYS = ['dependencies'] as const;
const EXTRA_TABLES = ['project.optional-dependencies', 'dependency-groups'] as const;
const POETRY_DEPENDENCY_TABLE = /^tool\.poetry(?:\.group\.[^.]+)?\.dependencies$/;

export interface PythonManifestDependencies {
  // Every requirement string found, verbatim (`"ruff>=0.5"`), plus poetry's bare key names.
  requirements: readonly string[];
  // Extra / dependency-group names declared, in declaration order. The bootstrap installs the
  // first recognised dev-ish one; see toolchain.ts's `pythonInstallCommand`.
  extras: readonly string[];
}

// Strips `#` comments from TOML/INI text while respecting string state, so a `#` inside a value
// (`homepage = "https://x/#frag"`, `addopts = "-m 'not slow' # keep"`) does not truncate the line.
// Newlines are preserved so a caller can still reason about line structure.
export function stripTomlComments(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    let quote: string | undefined;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (quote !== undefined) {
        if (ch === '\\' && quote !== "'") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '#') {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

// The quoted strings inside a `key = [ ... ]` array, which may span lines. Returns undefined when
// the key is absent or the array never closes -- an unterminated array is a manifest this file
// cannot read, and reading it half-way would be worse than not reading it.
function arrayValues(text: string, key: string): string[] | undefined {
  const opener = new RegExp(String.raw`^\s*${key.replace(/[-.]/g, '\\$&')}\s*=\s*\[`, 'm').exec(text);
  if (!opener) return undefined;
  let depth = 1;
  let i = opener.index + opener[0].length;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') depth -= 1;
  }
  if (depth !== 0) return undefined;
  const body = text.slice(opener.index + opener[0].length, i - 1);
  return [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? '');
}

// Splits a manifest into `{ table header -> body }`, comments already stripped. The root (before
// any header) is keyed ''.
// The table this parser uses for "everything I must not read". An ARRAY OF TABLES (`[[...]]`)
// never holds project dependencies, and its body must not be appended to the previous table --
// `[[tool.hatch.envs.test.matrix]] dependencies = [...]` was otherwise read as `[project]`'s.
const IGNORED_TABLE = '\u0000ignored';

function tables(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  let current = '';
  let body: string[] = [];
  const flush = (): void => {
    const existing = found.get(current);
    found.set(current, existing === undefined ? body.join('\n') : `${existing}\n${body.join('\n')}`);
  };
  // Multi-line basic/literal strings span lines, so a `[project.optional-dependencies]` written
  // inside a `description = """..."""` would otherwise be read as a real table header. Tracked
  // here rather than in stripTomlComments, which is deliberately line-local (a `#` is only ever a
  // comment on its own line).
  let openMultiline: string | undefined;
  for (const line of stripTomlComments(raw).split('\n')) {
    if (openMultiline !== undefined) {
      if (line.includes(openMultiline)) openMultiline = undefined;
      continue;
    }
    const opener = multilineOpener(line);
    if (opener !== undefined) {
      openMultiline = opener;
      continue;
    }
    if (/^\s*\[\[/.test(line)) {
      flush();
      current = IGNORED_TABLE;
      body = [];
      continue;
    }
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (header) {
      flush();
      current = header[1]!.replace(/\s|"|'/g, '');
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  found.delete(IGNORED_TABLE);
  return found;
}

// A line that OPENS a multi-line string and does not close it on the same line.
function multilineOpener(line: string): string | undefined {
  for (const quote of ['"""', "'''"]) {
    const at = line.indexOf(quote);
    if (at === -1) continue;
    if (line.indexOf(quote, at + 3) === -1) return quote;
  }
  return undefined;
}

// Every `key = [...]` in a table body, as `[key, values]`. Used for the extras tables, where the
// key is the extra's NAME and the array is its requirements.
function arrayEntries(body: string): [string, string[]][] {
  const entries: [string, string[]][] = [];
  for (const match of body.matchAll(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*\[/gm)) {
    const key = match[1] ?? match[2] ?? match[3]!;
    // The RAW key: `arrayValues` does its own escaping. Escaping here too produced a
    // double-escaped pattern that matched nothing, so any extra whose name contains `-` or `.`
    // was silently dropped -- including `dev-dependencies`, which is in DEV_EXTRA_PREFERENCE.
    const values = arrayValues(body, key);
    if (values !== undefined) entries.push([key, values]);
  }
  return entries;
}

export function pyprojectDependencies(raw: string | undefined): PythonManifestDependencies {
  if (raw === undefined) return { requirements: [], extras: [] };
  const byTable = tables(raw);
  const requirements: string[] = [];
  const extras: string[] = [];

  const project = byTable.get('project');
  if (project !== undefined) {
    for (const key of PEP621_ARRAY_KEYS) requirements.push(...(arrayValues(project, key) ?? []));
  }

  for (const table of EXTRA_TABLES) {
    const body = byTable.get(table);
    if (body === undefined) continue;
    for (const [name, values] of arrayEntries(body)) {
      extras.push(name);
      requirements.push(...values);
    }
  }

  for (const [name, body] of byTable) {
    if (!POETRY_DEPENDENCY_TABLE.test(name)) continue;
    // Poetry inverts the shape: the KEY is the distribution and the value is the constraint.
    for (const match of body.matchAll(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=/gm)) {
      requirements.push(match[1] ?? match[2] ?? match[3]!);
    }
    const group = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(name)?.[1];
    if (group !== undefined) extras.push(group);
  }

  return { requirements, extras };
}

// `requirements*.txt`: one requirement per line, `#` comments, and `-r`/`-c`/`--flag` directives
// that are not requirements. A line's requirement is everything before the first version specifier,
// marker or extras bracket.
export function requirementsDependencies(raw: string | undefined): PythonManifestDependencies {
  if (raw === undefined) return { requirements: [], extras: [] };
  const requirements = raw
    .split('\n')
    .map((line) => line.split('#')[0]!.trim())
    .filter((line) => line !== '' && !line.startsWith('-'));
  return { requirements, extras: [] };
}

// `setup.cfg` / `tox.ini`: the dependency keys only. A section HEADER (`[mypy]`, `[tool:pytest]`)
// is handled separately by the caller as its own, stronger, kind of evidence.
const INI_DEPENDENCY_KEYS = ['install_requires', 'tests_require', 'deps', 'setup_requires'] as const;

export function iniDependencies(raw: string | undefined): PythonManifestDependencies {
  if (raw === undefined) return { requirements: [], extras: [] };
  const stripped = stripTomlComments(raw);
  return { requirements: iniRequirements(stripped), extras: iniExtraNames(stripped) };
}

function iniRequirements(stripped: string): string[] {
  const requirements: string[] = [];
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*([A-Za-z_]+)\s*=(.*)$/.exec(lines[i]!);
    if (!match || !INI_DEPENDENCY_KEYS.includes(match[1] as (typeof INI_DEPENDENCY_KEYS)[number])) continue;
    // setuptools/tox write these as an indented block continuing under the key.
    const values = [match[2]!, ...indentedContinuation(lines, i + 1)];
    requirements.push(
      ...values
        .flatMap((value) => value.split(/[\n,]/))
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }
  return requirements;
}

function indentedContinuation(lines: readonly string[], from: number): string[] {
  const values: string[] = [];
  for (let j = from; j < lines.length; j += 1) {
    const line = lines[j]!;
    if (line.trim() === '') continue;
    if (!/^\s/.test(line) || /^\s*\[/.test(line)) break;
    values.push(line);
  }
  return values;
}

// `extras_require` is a section in setup.cfg (`[options.extras_require]`) whose keys are the extra
// names; the bootstrap only needs the names.
function iniExtraNames(stripped: string): string[] {
  const section = /^\s*\[options\.extras_require\]\s*$/m.exec(stripped);
  if (!section) return [];
  const extras: string[] = [];
  for (const line of stripped.slice(section.index + section[0].length).split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
    if (key !== undefined) extras.push(key);
  }
  return extras;
}

// Does any requirement string name this distribution? PEP 508 names are separated by `-`, `_` and
// `.`, so the boundary rejects every separator as well as an alphanumeric -- `pytest-cov` does not
// satisfy a lookup for `pytest`, and neither does `ruff-lsp` or `mypy-extensions`.
export function declaresDistribution(requirements: readonly string[], name: string): boolean {
  const pattern = new RegExp(String.raw`^${name}(?![\w.\-])`, 'i');
  return requirements.some((requirement) => pattern.test(requirement.trim()));
}
