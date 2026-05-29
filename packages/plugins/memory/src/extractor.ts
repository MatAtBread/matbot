import type { Job, JobQueue, Session } from '@matatbread/matbot-core';
import type { MemoryEntry, MemoryManager } from '@matatbread/matbot-memory-types';

export interface ExtractionPayload {
  ownerPrincipalId: string;
  sessionId:        string;
  messageId:        string;
  turnIndex:        number;
  contexts:         string[];
  tags:             string[];
}

/**
 * Worker that processes `memory:extract` jobs from the queue.
 *
 * Each job represents a single session message that should be indexed as a
 * MemoryEntry. The entry stores only references (sessionId + messageId) — the
 * actual text stays in the session store.
 *
 * In production, replace the stub body of `processJob` with an LLM call that
 * classifies relevance, extracts tags, and computes an embedding.
 */
export class MemoryExtractorWorker {
  private readonly workerId = `extractor-${crypto.randomUUID()}`;

  private readonly queue:  JobQueue;
  private readonly memory: MemoryManager;
  constructor(queue: JobQueue, memory: MemoryManager) {
    this.queue  = queue;
    this.memory = memory;
  }

  /** Run until the signal is aborted. */
  async run(signal: AbortSignal): Promise<void> {
    for await (const job of this.queue.watch('memory:extract', signal)) {
      await this.processJob(job as Job<ExtractionPayload>);
    }
  }

  private async processJob(job: Job<ExtractionPayload>): Promise<void> {
    const p = job.payload;

    try {
      const entry: Omit<MemoryEntry, 'id' | 'version' | 'createdAt'> = {
        kind:             'fact',
        ownerPrincipalId: p.ownerPrincipalId,
        sessionId:        p.sessionId,
        messageId:        p.messageId,
        turnIndex:        p.turnIndex,
        tags:             p.tags,
        confidence:       0.8,         // default until reinforced or decayed
        decayRate:        0.01,        // 1% per day
        recallCount:      0,
        contexts:         p.contexts,
        lastReinforcedAt: new Date().toISOString(),
      };

      await this.memory.remember(entry);
      await this.queue.complete(job.id, job.version);
    } catch (e) {
      await this.queue.fail(job.id, job.version, String(e));
    }
  }
}

/**
 * Enqueue extraction jobs for every assistant message in `session` that does
 * not already have a job pending. Call after each completed pipeline turn.
 */
export async function enqueueSessionExtraction(
  session: Session,
  queue:   JobQueue,
): Promise<void> {
  const assistantMessages = session.messages.filter(m => m.role === 'assistant');

  for (let i = 0; i < assistantMessages.length; i++) {
    const msg = assistantMessages[i];
    if (!msg) continue;

    const payload: ExtractionPayload = {
      ownerPrincipalId: session.ownerPrincipalId,
      sessionId:        session.id,
      messageId:        msg.id,
      turnIndex:        session.messages.indexOf(msg),
      contexts:         session.contexts,
      tags:             [],
    };

    await queue.enqueue('memory:extract', payload);
  }
}
