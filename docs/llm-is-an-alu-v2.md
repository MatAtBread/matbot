# The LLM is an ALU — and You're Paying a Tax Every Time It Talks to a Tool

> Lessons from a ZX Spectrum

*Matt Woolf*

---

Every time your LLM agent calls a tool and reads the result, you're paying a tax. Not in dollars — in tokens, latency, and reliability (ok, dollars then). The tool's output gets serialized into text, tokenized into the context window, attended to by the model, and then re-serialized when the model decides what to do next. If the next step is another tool call, the cycle repeats. Data that never needed the model's judgement flows through the most expensive component in your system — twice.

This isn't a minor inefficiency. It's the hidden cost centre of every agent framework, and it compounds: the more tools your agent uses, the more context it burns on data shuttling, the less reliable it becomes at the actual task, and the less you can observe about what went wrong when it fails.

I spent too long watching this happen in my own agent before I decided this was an old problem in new clothes, and it needed fixing. The agent wasn't broken. The architecture was. I was asking a stateless function to behave like a state machine, and paying the token tax every time the illusion slipped.

## What kind of machine is this, actually

The instinctive way to think about a large language model is as a slow, occasionally unreliable processor. Give it better prompts the way you'd give a CPU better-optimized code, give it more context the way you'd give it more RAM, wait for the next model generation the way you'd wait for a clock-speed bump, and the rough edges — the forgetfulness, the drifting attention, the tendency to lose the plot four tool calls into a procedure — will sand themselves down.

This is, I think, the consensus view, and it's wrong in a way that matters, because it assumes the LLM is a machine with the *kind* of deficiency that more resources fix. It isn't. It has a deficiency that's definitional, not incidental.

A CPU has a program counter. It has registers. It has a fetch-decode-execute cycle that advances on its own, instruction after instruction, whether or not anyone's watching. None of that requires intelligence — a $2 microcontroller has all of it. What it requires is *state that persists between operations*, and a mechanism for deciding what to do next based on that state. An LLM has neither. Hand it a token matrix, get a token matrix back, and the moment the call returns, every trace of "where it was" is gone. The only state it has is the state you handed it on the way in.

This is why "not Turing complete" isn't overstating the case, even though it sounds like a much bigger claim than it is. A Turing machine needs unbounded read-write memory it can consult and revise as it runs. An LLM has no memory it revises — it has an input it transforms once, in one pass, with no internal loop. It's not a *weak* general-purpose computer; it isn't a sequencer at all. It's the part of a computer that does the actual computing — the arithmetic-logic unit — wearing the entire system's clothes because nobody's built the rest of the system around it yet.

Worth being blunt: **LLMs aren't computers, so they struggle to run your programs.** A program is a sequence of steps where each one depends on what happened at the step before. There is no "before" inside a single forward pass — there's just this pass, this input, this output. LLMs don't "compute", they **_simulate computation_** in a single state.

And that's the part that makes "wait for the next model" a category error. A faster, smarter ALU is still an ALU. You can make the matrix multiply bigger, the context window longer, the next-token prediction sharper, and you will absolutely get a better-behaved ALU — fewer arithmetic errors, a wider operand. What you will not get, no matter how far you push it, is a program counter, because a program counter isn't a capability you scale into existence with more parameters. It's a different *kind* of thing, bolted on from outside.

Attention deficit, context bloat, the habit of forgetting an instruction given ten turns ago — these aren't bugs in the LLM. They're the entirely predictable consequence of asking a stateless function to behave like a state machine by reloading the *entire* machine's state through its only input slot, every single time, and hoping nothing gets dropped on the way in. Bigger context windows make that slot bigger. They don't give the ALU anywhere to put things it isn't actively being handed right now.

## The tokenization tax, made concrete

Here's a real pipeline an agent might run: search the web for recent articles about a topic, extract the full text of the top results, aggregate the key findings, and produce a summary.

**The naive way** — the way every agent framework does it by default:

```
Turn 1: Agent calls web_search({ query: "LLM agent memory management" })
→ Tool result (10 URLs + snippets, ~2,000 tokens) enters context
→ Agent reads results, picks 5 URLs to follow

Turn 2-6: Agent calls extract_url({ url }) for each of the 5 URLs
→ Each tool result (full article text, ~3,000-8,000 tokens each) enters context
→ Agent now has ~25,000 tokens of article content diluting its attention

Turn 7: Agent tries to summarize, but the context is bloated with raw HTML,
  boilerplate navigation, cookie notices, and tangential content from 5 articles.
  The summary is shallow because the model is drowning in irrelevant tokens.
```

The model saw every intermediate result — every URL, every snippet, every full article — because that's the only way it could decide what to do next. But it didn't *need* to see them. The data flow was purely mechanical: search → extract → aggregate → summarize. No judgement was required between steps. The judgement was only needed at the end, for the summarization itself.

**The composed way:** the agent writes a TypeScript function that orchestrates the entire pipeline. Search results stay in TypeScript. Article text stays in TypeScript. The aggregation happens in TypeScript. The only LLM call is a single, isolated `single_turn` for the summarization itself — with its own context window, so the main conversation is never polluted with raw article content. The final output — just the summary, source URLs, and article count — is the only thing the main model sees.

The token tax drops from ~25,000 tokens of intermediate results to ~200 tokens of final output. But the gains go far beyond token count.

## Why is this a harness thing

Because matbot does this for you. It is a strongly typed LLM harness that turns the LLM's plans and sessions into code. And writing code is something LLMs are good at.

## What you gain

**Token efficiency.** The most obvious win. Data that flows between tools without needing the model's judgement never enters the context window. In the example above, 25,000 tokens of article content became 200 tokens of summary. That's not a marginal optimization — it's a 99% reduction in context consumption for the mechanical steps.

**Observability.** Every step in the pipeline is inspectable. You can log the search results before extraction, count the articles, trace which URLs succeeded or failed, and debug the aggregation logic with a real debugger. The LLM's "reasoning" between tool calls is opaque; the TypeScript pipeline is transparent.

**Reliability.** The pipeline runs the same way every time. The search always happens before extraction. The aggregation always produces the same format. There's no risk of the model skipping a step, hallucinating a URL, or summarizing before all articles are fetched.

**Repeatability.** Same input, same pipeline, same output structure. The only non-deterministic step is the summarization — and that's isolated in its own LLM call, so the non-determinism is bounded and testable.

## What you pay

**Strict typing.** The composition layer requires TypeScript types for every tool's parameters and return values. This is the cost — but it's a cost the framework absorbs, not the developer. matbot generates live type declarations from the actual tools currently loaded, so the type-checker validates your composition against real contracts, not stubs. The LLM writes the tool as a function; the framework ensures it's type-safe.

**The key insight: LLMs are far better at writing code than they are at running it.**

This is the single most important thing I've learned building agent systems. An LLM can look at a procedure and generate a correct, type-safe TypeScript implementation in one shot. That same LLM, asked to *execute* the procedure step-by-step in context, will drift, skip steps, burn tokens, and produce unreliable results.

Play to the strength. Use the LLM as the compiler, not the interpreter.

## The four things LLMs can't give you (but TypeScript can)

When you ask an LLM to execute a multi-step procedure in context, you're asking for four things it structurally cannot provide:

**1. Reliability** — Will it follow the same steps in the same order every time? Not guaranteed. The model's attention drifts, especially in long contexts. A procedure that works on turn 1 may silently skip a step by turn 5.

**2. Repeatability** — Same input, same output? Only approximately. The model is a stochastic function. Two runs of the same procedure can take different branches, produce different intermediate results, or fail in different ways.

**3. Observability** — What actually happened between step 2 and step 3? You can't step through, set breakpoints, or inspect intermediate state. The model's "reasoning" is opaque — you see the input and the output, and you trust the process or you don't.

**4. Token economy** — Every branch, every conditional, every step description in your procedure burns tokens whether or not that branch is taken. A 10-step workflow with 3 conditionals costs you the full 10 steps of context every time, even when 7 of them are no-ops.

TypeScript gives you all four for free. Deterministic execution. Identical outputs for identical inputs. Full inspectability at every step. Zero token cost for control flow.

The insight isn't that LLMs are bad. It's that they're **extraordinary at one thing** — single-pass transforms over enormous operands — and **structurally incapable of another** — sustained, reliable, observable procedural execution. The fix isn't a better prompt. It's using the right tool for each job.

## Build the rest of the processor

I grew up on machines where you couldn't pretend this problem away, because the hardware made the boundary between "the part that computes" and "the part that remembers and sequences" completely explicit. I started on a ZX Spectrum with 48K of RAM. In an earlier life, I built the kernel for an early phone called the Pogo, running on a 33MHz ARM7. A full context switch there was six instructions: push every working register to a context block, swap a global pointer, pop the new task's registers back in. Microseconds. It worked because the hardware had already half-finished the job — and we leaned on that further, deliberately leaving one register unrestored on the way out of an interrupt so the C routine doing the actual switch could smuggle a return value through it.

None of this was clever in the way people mean when they say "clever code." It was clever in the older sense: knowing exactly what state exists, exactly where it lives, and exactly when it's safe to touch — and then doing the absolute minimum required to move it.

Once you've internalized that the *first* job is always "give the stateless core somewhere to keep state, and a counter that says what's next," the rest of processor history reads less like a museum and more like a checklist of problems you're about to have:

- **Stacks and call frames** — the moment your code wants to call a subroutine and come back
- **Interrupts** — the moment something outside the sequence needs to change what runs next
- **Memory banking** — when your address space (or context window) is smaller than your problem
- **MMUs** — when you get tired of managing that swapping by hand
- **Heap management** — because not everything fits neatly into a stack discipline
- **Hardware abstraction** — because you want software above a device to work regardless of the device
- **Context switching** — because two programs sharing one CPU need the illusion of having it to themselves
- **Compilers** — because once you've written the same procedural pattern by hand for the tenth time, you build something that does it for you

None of this required the processor to get smarter. The 8080 didn't become the 8086 by getting better at arithmetic. It got more useful because more got built around it.

## What this means for a harness

This is the question I started actually answering instead of just complaining about, and the answer is matbot — an agent framework where every one of those old lessons shows up doing real work.

The state the LLM doesn't have lives in **stores**: typed, addressable, durable collections that plugins read and write directly, without a round-trip through the model. Session history is the accumulator — the one piece of state always handed back in on the next call.

The program counter is ordinary TypeScript doing the fetch-decode-execute work the model can't: deciding what happens next, looping, branching, calling the model exactly when a genuine judgement is needed. **Hooks** are the interrupt lines. **Triggers** add the vectoring — a cheap, single-turn, context-free classifier decides whether the interrupt fires at all.

**Tool composition** is the direct answer to the tokenization tax. The agent writes TypeScript functions that orchestrate multiple tool calls in one pass. Data flows between tools without entering the model's context. The type-checker verifies the composition against live tool contracts before it runs. What was previously a multi-turn, token-burning, error-prone conversation becomes a single, typed, observable function call.

**The skills compiler** takes this further: feed it a markdown skill — a procedural playbook the LLM would otherwise interpret step-by-step, burning tokens on every heading and branch — and it produces a TypeScript plugin that does the same job deterministically. The LLM is invoked only for narrow, context-free judgement calls. Everything mechanical happens in code. The cost of interpretation, previously paid on every use of the skill, becomes a single compilation cost amortized over every use of the tool. The skill compiler _actually runs the skill in a sub-session, and then analyses what tools the session invoked_ so it has both the skill as the specification document, and the sub-session as a template to code from.

**Contextual search** is demand-paged knowledge: the model talks normally with no skills catalog in context, hits an unknown term, calls `contextual_search`, and a reranker pages in the relevant skill. You pay for the misses, not the hits — the same reason demand paging beat "load everything up front" decades before anyone called it that.

The **mount table** is the bus: plugins announce services (storage backends, knowledge indexes, skill managers) and the rest of the system discovers them. The **quiescent edge** is the clock: no state change commits mid-turn, only at the boundary where no tool call is in flight, so the system is always in a consistent state.

## What this isn't

I'll admit the risk: once you've spent decades thinking in interrupts and page tables, you start seeing every LLM problem as a systems-engineering nail. Not every skill needs compiling. Not every context problem needs a session manager modelled on a heap manager. You don't put virtual memory in a thermostat.

But naming the risk doesn't make the underlying parallel less real. Early computers had expensive cycles and scarce memory, so they grew IO, schedulers, interrupts, and paging. LLMs have expensive tokens and scarce context, and the exact same shape of problem is showing up: what to keep resident, what to fetch on demand, what to hand off to something cheaper, what to never let the expensive unit touch at all.

None of this is a claim that the model is bad. It's closer to the opposite: the model is, for what it actually is — a combinatorial transform over an enormous operand — extraordinary, and getting more extraordinary every year. What it will not become, by getting bigger, is a sequencer, because a sequencer was never a property of the function; it's a property of the system you build around the function.

Moore's Law never fixed anyone's memory management either — it just made it cheaper to get away with not doing any, for a while, until the workloads grew to fill whatever you'd been handed. The fix, then and now, was never going to come from inside the chip.

Build the rest of the machine, and the ALU you already have will turn out to be enough.

---

*matbot is open source: [github.com/MatAtBread/matbot](https://github.com/MatAtBread/matbot). The tool composition and skills compiler described here are running in production.*
