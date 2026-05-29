import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';

const THINKING_PHRASES = [
  'Consulting the knowledge base',
  'Checking your queue position',
  'Reviewing company policy section 7.3.2',
  'Attempting to locate a supervisor',
  'Supervisor unavailable — escalating further',
  'Running standard diagnostic checks',
  'Cross-referencing with the FAQ',
  'Searching for relevant ticket history',
  'Verifying your account details',
  'Liaising with the compliance team',
  'Optimising the response template',
  'Calculating your estimated wait time',
  'Listening to your concerns very carefully',
] as const;

const RESPONSES = [
  'Thank you for your message. You are being held in a queue and will be answered shortly \u{1F3B5}',
  'Your message is important to us. Please hold \u{1F3B5}',
  'Did you know you can contact us via our website? \u{1F3B5}',
  'Computer says no',
  'Your call is very important to us. Please continue to hold \u{1F3B5}',
  'We are currently experiencing unprecedented levels of demand. Our team will get back to you within 5–7 business days \u{1F3B5}',
  'Have you tried turning it off and on again?',
  'I’m sorry to hear you’re having trouble. Unfortunately this falls outside my remit. I will transfer you now \u{1F3B5}',
  'Your query has been logged and assigned reference number CS-404. Someone will be in touch shortly.',
  'Thank you for your patience. We value every customer’s feedback and take all complaints very seriously. We will not be changing anything. \u{1F3B5}',
  'For security purposes, please confirm your date of birth, mother’s maiden name, and the name of your first pet before we proceed.',
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

export class CustomerServicesAdapter implements ProviderAdapter {
  readonly name = 'customer-services';

  complete(
    _messages: Message[],
    _config:   ProviderConfig,
    _tools:    readonly Tool[],
    signal:    AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return this.stream(signal);
  }

  private async *stream(signal: AbortSignal): AsyncIterable<CompletionEvent> {
    const count    = 2 + Math.floor(Math.random() * 4);
    const totalMs  = Math.random() * 3000;
    const interval = totalMs / count;

    let fullThinking = '';
    for (let i = 0; i < count; i++) {
      try { await delay(interval, signal); } catch { return; }
      const text = `${pick(THINKING_PHRASES)}...\n`;
      fullThinking += text;
      yield { type: 'thinking', delta: text };
    }

    yield {
      type:      'thinking-block',
      thinking:  fullThinking,
      // A mock signature — real providers use cryptographic signatures here
      signature: `cs-mock-${crypto.randomUUID()}`,
    };

    if (signal.aborted) return;

    for (const char of pick(RESPONSES)) {
      yield { type: 'text-delta', delta: char };
    }

    yield { type: 'done' };
  }

  async health(): Promise<HealthStatus> {
    return { status: 'degraded', reason: 'All agents are currently busy. Your query is important to us \u{1F3B5}' };
  }
}
