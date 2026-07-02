import type { Tool } from '@matatbread/matbot-plugin-api';

/**
 * The description a provider sends on the wire. A matbot-native tool declares its call contract as
 * TypeScript text (`paramsType`/`resultType`); we append it so the model reasons about the real shapes,
 * not only the loose JSON-Schema `inputSchema` (the fallback foreign tools — e.g. MCP proxies — carry
 * instead, and which therefore omit these fields). A tool declaring neither renders byte-identically to
 * its `description`, so adoption is per-tool and never disturbs an existing description.
 */
export function toolWireDescription(tool: Tool): string {
  const lines: string[] = [];
  if (tool.paramsType !== undefined) lines.push(`  params: ${tool.paramsType}`);
  if (tool.resultType !== undefined) lines.push(`  result: ${tool.resultType}`);
  if (lines.length === 0) return tool.description;
  return `${tool.description}\n\nTypeScript:\n${lines.join('\n')}`;
}
