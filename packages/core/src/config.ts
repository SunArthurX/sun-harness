import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureDir, homePath, sunHome } from './paths.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatProvider } from './providers/openai.js';
import type { Provider } from './providers/types.js';

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';

export interface ProviderConfig {
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKeyEnv?: string;
  /** Prefer apiKeyEnv; a raw key is stored in plain text in ~/.sun/config.json. */
  apiKey?: string;
  models: string[];
  echoReasoning?: boolean;
  headers?: Record<string, string>;
  /** Local servers (e.g. Ollama) need no key. */
  noKey?: boolean;
  /** Default context window (tokens) for this provider's models. */
  contextWindow?: number;
  /** Per-model context windows (tokens), overriding built-in knowledge. */
  modelContext?: Record<string, number>;
}

export interface IntelSource {
  id: string;
  name: string;
  kind: 'github-releases' | 'github-changelog' | 'rss' | 'page';
  /** owner/repo for github kinds, URL otherwise. */
  target: string;
  /** Path of a changelog file in the repo for github-changelog. */
  path?: string;
}

export interface SunConfig {
  providers: Record<string, ProviderConfig>;
  defaultModel: string;
  /** Tried in order when the current model pauses for quota/auth. */
  fallbackModels: string[];
  approval: ApprovalMode;
  /** Deny (with a reason to the model) instead of waiting for a human. Always on when no approver is attached. */
  denyInsteadOfPrompting: boolean;
  maxSteps: number;
  autoResume: { enabled: boolean; intervalMinutes: number };
  /** thresholdTokens is an absolute cap; buffer ("20%" or a token count) is kept free below the model's context window. */
  compaction: { thresholdTokens: number; keepRecent: number; buffer: string | number };
  rules: { globalMaxChars: number; projectMaxChars: number };
  skills: { extraDirs: string[]; compat: boolean };
  /** Every folder in ~/.sun/plugins loads unless listed in `disabled`. */
  plugins: { disabled: string[]; settings: Record<string, Record<string, unknown>> };
  mcp: { enabled: boolean };
  kb: {
    roots: string[];
    company: { enabled: boolean; baseUrl: string; tokenEnv?: string; name?: string };
    /** Hybrid retrieval: BM25 + embeddings ("provider/model", OpenAI-compatible /embeddings). Off by default: notes are sent to the provider. */
    embeddings: { enabled: boolean; model: string; dimensions?: number };
  };
  intel: { sources: IntelSource[]; analysisModel?: string; hour: number; minute: number };
  evolution: { autoReflect: boolean };
  /** Tool calls (MCP) still running after promoteAfterMs move to the background (0 disables). */
  jobs: { promoteAfterMs: number; killOnExit: boolean };
}

export const PROVIDER_PRESETS: Record<string, ProviderConfig> = {
  deepseek: {
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  anthropic: {
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  openai: {
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
  },
  glm: {
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'GLM_API_KEY',
    models: ['glm-4.6', 'glm-4.5-air'],
  },
  qwen: {
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    models: ['qwen3-coder-plus', 'qwen-plus', 'qwen-max'],
  },
  gemini: {
    type: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  openrouter: {
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5'],
  },
  ollama: {
    type: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    noKey: true,
    models: ['qwen3-coder', 'llama3.1'],
  },
};

export const DEFAULT_INTEL_SOURCES: IntelSource[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'github-changelog', target: 'anthropics/claude-code', path: 'CHANGELOG.md' },
  { id: 'codex', name: 'OpenAI Codex CLI', kind: 'github-releases', target: 'openai/codex' },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'github-releases', target: 'google-gemini/gemini-cli' },
  { id: 'opencode', name: 'OpenCode', kind: 'github-releases', target: 'sst/opencode' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', kind: 'github-releases', target: 'deepseek-ai/deepseek-harness' },
  { id: 'cline', name: 'Cline', kind: 'github-releases', target: 'cline/cline' },
  { id: 'aider', name: 'Aider', kind: 'github-releases', target: 'Aider-AI/aider' },
  { id: 'goose', name: 'Goose', kind: 'github-releases', target: 'block/goose' },
  { id: 'qwen-code', name: 'Qwen Code', kind: 'github-releases', target: 'QwenLM/qwen-code' },
  { id: 'openhands', name: 'OpenHands', kind: 'github-releases', target: 'All-Hands-AI/OpenHands' },
  { id: 'hermes-agent', name: 'Hermes Agent', kind: 'github-releases', target: 'NousResearch/hermes-agent' },
  { id: 'crush', name: 'Crush', kind: 'github-releases', target: 'charmbracelet/crush' },
  { id: 'mcp-spec', name: 'MCP Specification', kind: 'github-releases', target: 'modelcontextprotocol/modelcontextprotocol' },
  { id: 'cursor', name: 'Cursor Changelog', kind: 'page', target: 'https://cursor.com/changelog' },
];

export function defaultConfig(): SunConfig {
  return {
    providers: {},
    defaultModel: '',
    fallbackModels: [],
    approval: 'auto-edit',
    denyInsteadOfPrompting: false,
    maxSteps: 60,
    autoResume: { enabled: true, intervalMinutes: 15 },
    compaction: { thresholdTokens: 200000, keepRecent: 12, buffer: '25%' },
    rules: { globalMaxChars: 12000, projectMaxChars: 40000 },
    skills: { extraDirs: [], compat: true },
    plugins: { disabled: [], settings: {} },
    mcp: { enabled: true },
    kb: { roots: [homePath('kb')], company: { enabled: false, baseUrl: '', tokenEnv: 'COMPANY_KB_TOKEN', name: 'Company KB' }, embeddings: { enabled: false, model: 'qwen/text-embedding-v4' } },
    intel: { sources: DEFAULT_INTEL_SOURCES, hour: 9, minute: 0 },
    evolution: { autoReflect: false },
    jobs: { promoteAfterMs: 30000, killOnExit: false },
  };
}

function configFile(): string {
  return homePath('config.json');
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export function loadConfig(): SunConfig {
  let user: Partial<SunConfig> = {};
  if (existsSync(configFile())) {
    try {
      user = JSON.parse(readFileSync(configFile(), 'utf8'));
    } catch (e) {
      throw new Error(`Invalid JSON in ${configFile()}: ${(e as Error).message}`);
    }
  }
  const cfg = deepMerge(defaultConfig(), user);
  cfg.providers = { ...PROVIDER_PRESETS, ...(user.providers ?? {}) };
  for (const [id, p] of Object.entries(user.providers ?? {})) {
    if (PROVIDER_PRESETS[id]) cfg.providers[id] = { ...PROVIDER_PRESETS[id], ...p };
  }
  if (!cfg.defaultModel) cfg.defaultModel = availableModels(cfg)[0] ?? 'deepseek/deepseek-chat';
  return cfg;
}

/** Persist only the user-owned part (a partial patch merged over the existing file). */
export function saveConfig(patch: Partial<SunConfig>): SunConfig {
  ensureDir(sunHome());
  let user: Record<string, unknown> = {};
  if (existsSync(configFile())) user = JSON.parse(readFileSync(configFile(), 'utf8'));
  const next = deepMerge(user, patch);
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n');
  return loadConfig();
}

export function providerKey(p: ProviderConfig): string | undefined {
  return p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined);
}

export function isProviderReady(p: ProviderConfig): boolean {
  return !!p.noKey || !!providerKey(p);
}

/** "provider/model" → parts. Model names may contain "/" (OpenRouter), so split at the first slash. */
/** Known context windows (tokens). Config `modelContext` / `contextWindow` override these. */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-4.1': 1_047_576,
  'glm-4.6': 200_000,
  'glm-4.5-air': 128_000,
  'qwen3-coder-plus': 1_000_000,
  'qwen-plus': 131_072,
  'qwen-max': 32_768,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
};

export function contextWindowOf(cfg: SunConfig, ref: string): number {
  const { provider, model } = parseModelRef(ref);
  const p = cfg.providers[provider];
  const base = model.split('/').pop()!;
  return (
    p?.modelContext?.[model] ??
    KNOWN_CONTEXT_WINDOWS[model] ??
    KNOWN_CONTEXT_WINDOWS[base] ??
    (/claude/.test(model) ? 200_000 : undefined) ??
    p?.contextWindow ??
    (provider === 'ollama' ? 32_768 : 128_000)
  );
}

/** Token count at which history is compacted for this model: window minus buffer, capped by thresholdTokens. */
export function compactionLimit(cfg: SunConfig, ref: string): number {
  const window = contextWindowOf(cfg, ref);
  const b = cfg.compaction.buffer ?? '25%';
  const buffer = typeof b === 'number' ? b : /%$/.test(b) ? (window * parseFloat(b)) / 100 : Number(b) || window * 0.25;
  return Math.max(1000, Math.min(cfg.compaction.thresholdTokens, Math.floor(window - buffer)));
}

export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i < 0) return { provider: 'deepseek', model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function availableModels(cfg: SunConfig): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(cfg.providers)) {
    if (id === 'ollama' || !isProviderReady(p)) continue;
    for (const m of p.models) out.push(`${id}/${m}`);
  }
  return out;
}

export type ProviderFactory = (ref: string) => { provider: Provider; model: string };

export function createProviderFactory(cfg: SunConfig): ProviderFactory {
  const cache = new Map<string, Provider>();
  return (ref: string) => {
    const { provider: pid, model } = parseModelRef(ref);
    const pc = cfg.providers[pid];
    if (!pc) throw new Error(`Unknown provider "${pid}" in model "${ref}". Configure it in ~/.sun/config.json.`);
    let provider = cache.get(pid);
    if (!provider) {
      const apiKey = providerKey(pc);
      provider =
        pc.type === 'anthropic'
          ? new AnthropicProvider({ id: pid, baseUrl: pc.baseUrl, apiKey })
          : new OpenAICompatProvider({ id: pid, baseUrl: pc.baseUrl, apiKey, headers: pc.headers, echoReasoning: pc.echoReasoning });
      cache.set(pid, provider);
    }
    return { provider, model };
  };
}
