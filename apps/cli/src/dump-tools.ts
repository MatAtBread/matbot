import type { MatbotMachine } from '@matatbread/matbot-core';
import { wireDescription }    from '@matatbread/matbot-core';
import { writeFile }          from 'node:fs/promises';
import process                from 'node:process';
import path                   from 'node:path';
import { yellow }             from './terminal.js';

// `--dump-tools [path]`: serialize the live registry. Each tool's `description` is the WIRE description —
// its raw description with the ToolContracts / `toolContract` TS shapes folded in by
// ToolTypeIndex.wireContracts(), exactly as the model sees it — plus its `inputSchema` and any soft-tool
// `toolContract`. Run once every plugin + core tool is registered and the type index is populated. Used to
// build corpora for the tool-search work.
export async function dumpTools(services: MatbotMachine, file: string): Promise<void> {
  const wire = await services.ToolTypeIndex?.wireContracts();
  const dump = services.tools.list().map(t => {
    const wc = wire?.[t.name];
    return {
      name:        t.name,
      description: wireDescription(t.description, wc),
      inputSchema: t.inputSchema,
      // Also unfolded, because the two artefacts on this object are what `check-tool-contracts.mjs`
      // compares — and recovering the contract by regexing it back out of the prose it was just
      // folded into would break on any description that happens to contain the same fence.
      ...(wc !== undefined ? { wireContract: wc } : {}),
      ...(t.toolContract !== undefined ? { toolContract: t.toolContract } : {}),
    };
  });
  const outPath = path.resolve(file);
  await writeFile(outPath, JSON.stringify(dump, null, 2), 'utf8');
  process.stderr.write(yellow(`[matbot] dumped ${dump.length} tools → ${outPath}\n`));
}
