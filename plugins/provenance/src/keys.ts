/** Settings key for the provider that READS located extracts. Shared by the tool that consumes it and
 *  the tool that sets it, so the two cannot drift apart. Never applies to the cold probe. */
export const CLASSIFIER_PROVIDER_KEY = 'classifierProvider';

/** Settings key for the list of tool names whose output is excluded from the search pool. Used to
 *  suppress noise (verbose tools) and self-reference (this tool citing its own prior verdicts as
 *  evidence for the claims those verdicts were about). */
export const IGNORE_TOOLS_KEY = 'ignoreTools';

/** Default excluded tools. `determine_provenance` excludes itself: its output is a set of verdicts
 *  ABOUT claims, not observation of the world, so citing it as evidence for a claim it just judged
 *  is circular. Callers can override via the tool's `ignoreTools` param or via `provenance_config`. */
export const DEFAULT_IGNORE_TOOLS: readonly string[] = ['determine_provenance'];
