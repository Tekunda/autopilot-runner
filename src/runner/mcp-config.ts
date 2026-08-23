// Translates a grant's signed McpGrant into the claude-code-action `--mcp-config` file the
// runner writes inside the customer's CI, plus the mcp tool allowlist that step must be given.
// Pure (no I/O) so it's unit-testable; prepare-stage.ts writes the returned JSON to a temp
// file and passes both through as action outputs.
//
// SECURITY (AGENTS.md, "split plane"): a server's auth token is NEVER embedded here. The
// grant carries only the env-var NAME (McpServerSpec.authEnvVar); the config file references
// it as a `${NAME}` placeholder, which the vendor step's own shell/loader expands from the
// env var the tenant's CI supplies. No secret VALUE ever appears in the grant, this JSON, or
// any log.

import type { McpGrant } from '../contracts/types.ts';

// The claude-code-action mcp-config file: a map of server name -> transport-specific config.
// http/sse carry a url (+ optional bearer header); stdio carries a command/args (+ optional
// env). All auth uses a `${VAR}` placeholder, never a literal token.
interface McpServerFileConfig {
  type?: 'http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpConfigResult {
  /** The `--mcp-config` file contents (JSON), ready to write verbatim. */
  json: string;
  /** The mcp tool names (`mcp__<server>__<tool>`) to add to the step's `--allowedTools`. */
  allowedTools: string[];
}

function serverFileConfig(server: McpGrant['servers'][number]): McpServerFileConfig {
  const placeholder = server.authEnvVar ? `\${${server.authEnvVar}}` : undefined;

  if (server.transport === 'stdio') {
    return {
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(placeholder && server.authEnvVar ? { env: { [server.authEnvVar]: placeholder } } : {}),
    };
  }

  return {
    type: server.transport,
    ...(server.url ? { url: server.url } : {}),
    ...(placeholder ? { headers: { Authorization: `Bearer ${placeholder}` } } : {}),
  };
}

// Build the mcp-config file contents and tool allowlist from a grant's McpGrant.
export function buildMcpConfig(mcp: McpGrant): McpConfigResult {
  const mcpServers: Record<string, McpServerFileConfig> = {};
  for (const server of mcp.servers) {
    mcpServers[server.name] = serverFileConfig(server);
  }
  return {
    json: JSON.stringify({ mcpServers }),
    allowedTools: mcp.allowedTools,
  };
}
