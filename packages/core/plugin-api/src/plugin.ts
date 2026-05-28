import type {
  MemoryManager, FileStore, Vault, Message, ModelParameters,
  ProviderAdapter, ProviderConfig, Tool, ToolRegistry, FrontendAdapter,
  Store, Session,
} from './types.js';
import type { HookRegistry } from './hooks.js';

export const PLUGIN_API_VERSION = '0.1';

// ── Sub-runner types ──────────────────────────────────────────────────────────

export interface CompletionRequest {
  provider:    string;
  messages:    Message[];
  system?:     string;
  parameters?: Partial<ModelParameters>;
  signal?:     AbortSignal;
}

export interface CompletionResponse {
  text:  string;
  usage: { inputTokens: number; outputTokens: number };
}

// ── Plugin settings ───────────────────────────────────────────────────────────

/** Scoped key-value store for a single plugin's runtime settings. */
export interface PluginSettings {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

// ── Services container ────────────────────────────────────────────────────────

export interface MatbotServices {
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** Returns a namespaced settings store for the given plugin. Keys are isolated per plugin name. */
  settings(pluginName: string): PluginSettings;

  /** Hot-load a plugin by specifier into the running process. */
  loadPlugin(specifier: string): Promise<void>;

  readonly providers:   ReadonlyMap<string, ProviderConfig>;
  readonly stores?:      { readonly sessions?: Store<Session> };
  readonly extensions?:  Record<string, unknown>;
  readonly memory?:     MemoryManager;
  readonly files?:      FileStore;
  readonly vault:       Vault;
  readonly hooks:       HookRegistry;
  readonly tools:       ToolRegistry;
  /** Default working directory for tool execution. Plugins that create servers should forward this to tool contexts. */
  readonly workdir?:    string;
  /** Absolute path to the loaded config file. Plugins that create servers should forward this to tool contexts. */
  readonly configPath?: string;
}

// ── Factory types ─────────────────────────────────────────────────────────────

export type ProviderAdapterFactory = (config: ProviderConfig) => ProviderAdapter;

export type StorageKind = 'sessions' | 'memory' | 'jobs';

export type StoreFactory = (
  kind:    StorageKind,
  options: Record<string, unknown>,
) => Store<{ id: string; version: string }>;

export type FrontendFactory = (services: MatbotServices) => FrontendAdapter;

// ── Plugin manifest ───────────────────────────────────────────────────────────

export interface PluginManifest {
  /** Human-readable description shown by `matbot install` */
  description?: string;
  /** Process env var names required by this plugin (e.g. 'OPENAI_API_KEY') */
  credentials?: readonly string[];
  /** matbot.yaml extensions.<pluginName> keys this plugin reads */
  config?: readonly string[];
}

// ── Plugin interface ──────────────────────────────────────────────────────────

export interface MatbotPlugin {
  readonly name:       string;
  readonly apiVersion: string;
  readonly manifest?:  PluginManifest;
  readonly providers?: Record<string, ProviderAdapterFactory>;
  readonly storage?:   Record<string, StoreFactory>;
  readonly tools?:     readonly Tool[];
  readonly frontend?:  FrontendFactory;
  setup?(services: MatbotServices): Promise<void>;
  teardown?(): Promise<void>;
}
