// `security-deps` / `cve` gate: dependency audit via deterministic tooling
// (npm audit) — never the LLM, per AGENTS.md ("Deterministic control, LLM
// only for judgment"). The audit tool is injected as a DependencyAuditor so
// the gate's own logic (severity thresholding, formatting) is pure and
// testable without shelling out; the default factory wires up the real
// `npm audit --json` tool. See issue #77.

import { runCommand } from '../exec.ts';
import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set(['low', 'moderate', 'high', 'critical']);

export interface DependencyAdvisory {
  packageName: string;
  severity: Severity;
  id: string;
  title: string;
}

export interface DependencyAuditor {
  // `cwd` is the tree to audit -- the customer's checked-out PR (ctx.workspaceRoot),
  // not the runner's own action directory. Falls back to process.cwd() when empty.
  audit(cwd?: string): Promise<DependencyAdvisory[]>;
}

export interface CveGateConfig {
  minSeverity: Severity;
}

const DEFAULT_CONFIG: CveGateConfig = { minSeverity: 'high' };

interface NpmAuditVia {
  title?: string;
  url?: string;
  severity?: string;
}

interface NpmAuditVulnerability {
  severity: string;
  via: (string | NpmAuditVia)[];
}

interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

function normalizeSeverity(raw: string | undefined): Severity {
  return raw && KNOWN_SEVERITIES.has(raw) ? (raw as Severity) : 'low';
}

// Exported for tests: turns a parsed `npm audit --json` report into the
// gate's own advisory shape, without needing to invoke npm at all. A `via`
// entry that's a plain string names a transitive dependency, not an
// advisory itself, so it's skipped.
export function parseNpmAuditReport(report: NpmAuditReport): DependencyAdvisory[] {
  const advisories: DependencyAdvisory[] = [];
  for (const [packageName, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (typeof via === 'string') continue;
      advisories.push({
        packageName,
        severity: normalizeSeverity(via.severity ?? vuln.severity),
        id: via.url ?? `${packageName}@${vuln.severity}`,
        title: via.title ?? `${packageName} dependency vulnerability`,
      });
    }
  }
  return advisories;
}

export function createNpmAuditor(): DependencyAuditor {
  return {
    async audit(cwd?: string) {
      // npm audit exits non-zero when it finds vulnerabilities; its JSON report
      // is still on stdout in that case, so runCommand recovers the exit as a
      // result and we parse stdout regardless of the code. A process that could
      // not spawn rejects out of runCommand and propagates as before.
      const { stdout } = await runCommand('npm', ['audit', '--json'], cwd || process.cwd());
      return parseNpmAuditReport(JSON.parse(stdout) as NpmAuditReport);
    },
  };
}

export function createCveGate(auditor: DependencyAuditor = createNpmAuditor()): Gate {
  return {
    id: 'cve',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig(ctx.config, 'cve', DEFAULT_CONFIG);
      const threshold = SEVERITY_RANK[config.minSeverity];
      const advisories = await auditor.audit(ctx.workspaceRoot);
      const findings = advisories
        .filter((advisory) => SEVERITY_RANK[advisory.severity] >= threshold)
        .map((advisory) => `${advisory.id}: ${advisory.packageName} (${advisory.severity}) — ${advisory.title}`);

      return {
        id: 'cve',
        status: findings.length > 0 ? 'fail' : 'pass',
        ...(findings.length ? { findings } : {}),
      };
    },
  };
}
