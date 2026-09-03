// The provisioning entry point action.yml runs. Downloads every pinned tool, VERIFIES its
// SHA-256, installs from the verified file, writes the receipt, and exports the two env vars
// the gates resolve against.
//
// WHY THIS IS NODE AND NOT A BASH STEP. The obvious shape for this is six lines of `curl` +
// `sha256sum -c` in action.yml. It was not written that way for three reasons, all of which
// have bitten this repo's YAML before:
//   - The pins would then live in the YAML, a second copy of manifest.ts that drifts the first
//     time someone bumps one and not the other. Here the YAML names no version at all.
//   - Verification logic in a composite-action `run:` block is untestable. This is the code
//     that decides whether a security scanner's bytes are trusted; it gets unit tests.
//   - `set -euo pipefail` is not on by default in a composite action's bash, so a failed
//     `curl` mid-pipeline is silently survivable -- which is how an unverified tool gets
//     installed by a step that reported success.
//
// EXIT CODES ARE DELIBERATELY 0. Provisioning failure must NOT fail the workflow: the gates
// each report their own honest `skip`, with a reason naming what was missing, and that is a
// far better outcome than a red job with no gate report at all. What this program guarantees
// is that it never leaves a receipt behind for a tool it did not verify -- so a gate can never
// mistake a failed provisioning for a successful one.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isDirectlyExecuted } from '../../runner/entrypoint.ts';
import { runCommand } from '../exec.ts';
import { CODE_ANALYZER, PINNED_TOOLS, SF_CLI } from './manifest.ts';
import {
  binDirOf,
  clearReceipt,
  fetchAndVerify,
  isExecutableFile,
  PROVISION_DIR_ENV,
  SF_BIN_ENV,
  toolchainCacheKey,
  writeReceipt,
} from './provision.ts';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function log(line: string): void {
  process.stdout.write(`[salesforce-provision] ${line}\n`);
}

// GitHub's own mechanism for a step to export env to later steps. Absent outside Actions, in
// which case the caller reads the values off stdout instead.
function exportEnv(name: string, value: string): void {
  const file = process.env.GITHUB_ENV;
  log(`${name}=${value}`);
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, `${name}=${value}\n`);
  } catch (err) {
    log(`could not write ${name} to GITHUB_ENV: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function provision(cacheDir: string, exec: typeof runCommand = runCommand): Promise<boolean> {
  mkdirSync(cacheDir, { recursive: true });
  // Drop any receipt from a previous run FIRST. The receipt is what makes a gate call its tool
  // `pinned`; if this run fails midway, a stale one left behind would vouch for a toolchain
  // that is no longer installed. Every `return false` below therefore leaves no receipt at all.
  clearReceipt(cacheDir);
  const prefix = path.join(cacheDir, 'prefix');
  const sfBin = path.join(binDirOf(prefix), 'sf');

  // 1. Fetch + verify EVERY tool before installing ANY of them. A half-provisioned toolchain
  //    whose second tarball failed its checksum must not leave the first one installed and a
  //    receipt implying both are good.
  const files = new Map<string, string>();
  for (const tool of PINNED_TOOLS) {
    const outcome = await fetchAndVerify(tool, cacheDir);
    if (!outcome.ok) {
      log(`REFUSED ${tool.packageName}@${tool.version}: ${outcome.reason}`);
      log('no receipt written; the Salesforce gates will report an honest skip rather than a pass.');
      return false;
    }
    log(`verified ${tool.packageName}@${tool.version} (sha256 ${tool.sha256})`);
    files.set(tool.id, outcome.file);
  }

  // 2. Install the CLI from the verified FILE, never from the registry by name -- installing
  //    by name here would discard everything the checksum just proved. Both tarballs ship an
  //    npm-shrinkwrap.json, so npm resolves the whole tree to the versions the publisher
  //    locked rather than to whatever satisfies a range today.
  const cliTarball = files.get(SF_CLI.id)!;
  try {
    const install = await exec('npm', ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', cliTarball], cacheDir, {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (install.exitCode !== 0) {
      log(`npm install of ${SF_CLI.packageName} exited ${install.exitCode}: ${install.stderr.slice(0, 2000)}`);
      return false;
    }
  } catch (err) {
    log(`npm install of ${SF_CLI.packageName} could not run: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  if (!isExecutableFile(sfBin)) {
    log(`the Salesforce CLI installed but no executable appeared at ${sfBin}; nothing is exported.`);
    return false;
  }

  // 3. Install the Code Analyzer plugin from ITS verified file, into a plugin root inside the
  //    cache so the whole toolchain restores as one unit on a cache hit.
  // The exact version, never a range and never `latest` -- see (b) below for why this is a
  // name rather than the verified file sitting in `files`.
  const pluginSpec = `${CODE_ANALYZER.packageName}@${CODE_ANALYZER.version}`;
  const dataDir = path.join(cacheDir, 'sf-data');
  const configDir = path.join(cacheDir, 'sf-config');

  //    TWO THINGS HAD TO BE LEARNED HERE THE EXPENSIVE WAY, both by running this program:
  //
  //    (a) `sf plugins install` refuses to install an unsigned plugin non-interactively: its
  //        plugin-trust hook prompts for confirmation and, with no TTY, throws
  //        InstallationCanceledError. The supported non-interactive answer is the CLI's own
  //        `unsignedPluginAllowList.json`, a JSON array of package names. It lives in oclif's
  //        CONFIG dir, which is NOT the data dir -- @oclif/core resolves it as
  //        `scopedEnvVar('CONFIG_DIR') || dir('config')`, i.e. $SF_CONFIG_DIR. Writing it next
  //        to SF_DATA_DIR looks right and silently does nothing.
  //
  //    (b) THE PLUGIN CANNOT BE INSTALLED FROM THE VERIFIED FILE, however much we would like it
  //        to be. `sf plugins install <path.tgz>` does not treat a path as a path: oclif
  //        classifies any non-npm-name argument as a GitHub repo and rewrites it, so the
  //        install was attempted against `https://github.com//private/tmp/.../plugin.tgz` and
  //        the allowlist was then consulted for THAT mangled string. There is no spelling of a
  //        local tarball that reaches the allowlist branch.
  //
  //    So the plugin is installed BY NAME AT THE PINNED EXACT VERSION, and the checksum is a
  //    GATE ON WHETHER TO INSTALL AT ALL rather than the source of the installed bytes. The
  //    chain still binds, and it is worth being exact about how:
  //      - We fetched the tarball for this exact version and matched it against a SHA-256 that
  //        is a CONSTANT IN THIS REPOSITORY, not something fetched alongside it. If the
  //        registry has been made to serve different bytes for 5.16.0, that check fails and we
  //        install nothing.
  //      - npm then downloads that same exact version and verifies it against the registry's
  //        published `integrity` for it. Both parties end up checking the same artefact.
  //      - What this does NOT defend against is a registry that serves good bytes to our
  //        fetch and bad bytes to npm's, in the same run, with matching published metadata.
  //        That is strictly weaker than installing the verified file, and it is documented
  //        here rather than papered over.
  //
  //    The allowlist names that ONE package, so it cannot vouch for anything else a later step
  //    tries to install.
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'unsignedPluginAllowList.json'),
      `${JSON.stringify([CODE_ANALYZER.packageName], undefined, 2)}\n`,
    );
  } catch (err) {
    log(`could not write the unsigned-plugin allowlist: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const sfEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SF_CONFIG_DIR: configDir,
    SF_DATA_DIR: dataDir,
    SF_CACHE_DIR: path.join(cacheDir, 'sf-cache'),
    // The provisioning step is not a place to phone home, and telemetry adds a network
    // dependency to a step whose failure mode we care about.
    SF_DISABLE_TELEMETRY: 'true',
    SF_AUTOUPDATE_DISABLE: 'true',
    // An auto-update would replace the exact bytes the checksum verified, which would make the
    // pin meaningless the first time upstream published a new version.
    SF_SKIP_NEW_VERSION_CHECK: 'true',
  };
  try {
    const plugin = await exec(sfBin, ['plugins', 'install', pluginSpec], cacheDir, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: sfEnv,
    });
    if (plugin.exitCode !== 0) {
      log(`\`sf plugins install\` exited ${plugin.exitCode}: ${plugin.stderr.slice(0, 2000)}`);
      return false;
    }
  } catch (err) {
    log(`\`sf plugins install\` could not run: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // 4. Only now, with every tool verified AND installed, is the receipt written. The receipt
  //    is what a gate reads to call its tool `pinned`, so it must never exist for a toolchain
  //    that is not actually there.
  writeReceipt(cacheDir, PINNED_TOOLS);
  exportEnv(PROVISION_DIR_ENV, cacheDir);
  exportEnv(SF_BIN_ENV, sfBin);
  // Later steps run `sf` through the exported path, but the plugin needs the same
  // config/data/cache dirs it was installed with or it will not be found.
  exportEnv('SF_CONFIG_DIR', configDir);
  exportEnv('SF_DATA_DIR', dataDir);
  exportEnv('SF_CACHE_DIR', path.join(cacheDir, 'sf-cache'));
  exportEnv('SF_DISABLE_TELEMETRY', 'true');
  exportEnv('SF_AUTOUPDATE_DISABLE', 'true');
  log('Salesforce toolchain ready.');
  return true;
}

// "Was this module the entry point?" -- guarded so tests can import `provision()` without
// provisioning anything.
//
// THE ONE HELPER, not a local comparison. `import.meta.main` alone would be wrong here: it is
// Node >= 24.2.0 while this package declares `engines.node: ">=22"`, so on the declared floor
// it is `undefined`, the block below would silently not run, `provision-cli.ts <dir>` would
// exit 0 having done nothing, and every Salesforce gate would then report its honest "no
// toolchain" skip -- correct behaviour from the gates, for a cause nothing in the logs names.
// A hand-rolled `import.meta.url === pathToFileURL(argv[1]).href` fallback is wrong in the
// other direction: Node realpaths `import.meta.url` but not `argv[1]`, so one symlinked
// checkout or bind-mount reintroduces the same silent no-op.
//
// `isDirectlyExecuted` (src/runner/entrypoint.ts, #417) handles both, and a source-scan test
// there pins that NO file under src/ hand-rolls the comparison. That is the point: this guard
// decides whether provisioning happens at all, so a second implementation of it is a second
// thing that can be subtly wrong.
if (isDirectlyExecuted(import.meta.url)) {
  // `--cache-key` prints the actions/cache key and exits. It exists so action.yml can key its
  // cache off the PINS without typing a version into the YAML: the key is derived from every
  // tool's version+digest, so bumping manifest.ts simply misses the old entry instead of
  // restoring it and failing a digest check for reasons invisible from the workflow file.
  if (process.argv[2] === '--cache-key') {
    process.stdout.write(`${toolchainCacheKey(PINNED_TOOLS)}\n`);
  } else {
    const cacheDir = process.argv[2] ?? process.env[PROVISION_DIR_ENV] ?? path.join(process.cwd(), '.autopilot-sf-tools');
    const ok = await provision(cacheDir);
    if (!ok) {
      // Exit 0 on purpose -- see the header. A failed provisioning is reported by every gate
      // as a skip with a reason, which is strictly more informative than a dead job.
      log('provisioning did not complete; the Salesforce gates will skip with a reason.');
    }
  }
}
