// Run isolated live-model qualification. Unit tests never call this entry point.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  availableModels, BUILTIN_MODES, createProviderFactory, defaultConfig, HarnessHost,
  loadConfig, parseModelRef, providerKey, runEval, validateSuite,
} from '../packages/core/dist/index.js';
import { handoffFixtureInputs } from './check-settings-plan.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: {
  validate: { type: 'boolean' },
  model: { type: 'string' },
  out: { type: 'string' },
  checkpoint: { type: 'string' },
} });
if (!values.validate && (!values.model || !values.out || !['post-t04', 'post-t15'].includes(values.checkpoint))) {
  throw new Error('Provide --model, --out, and --checkpoint post-t04 or post-t15. Use --validate for offline fixture checks.');
}
if (process.platform !== 'darwin') throw new Error('The isolated qualification judge currently requires macOS.');

const fixtureSource = join(root, 'evals/settings-qualification');
const scratch = mkdtempSync(join(tmpdir(), 'sun-settings-qualification-'));
const suite = join(scratch, 'suite');
const state = join(scratch, 'state');
const { prompt, promptSha256, suiteSha256 } = handoffFixtureInputs(root);
const taskDirs = readdirSync(fixtureSource, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

function json(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function makePlugin() {
  const { id, label, description, prompt: codingPrompt } = BUILTIN_MODES.find(mode => mode.id === 'coding');
  const dir = join(state, 'plugins', 'qualification');
  mkdirSync(dir, { recursive: true });
  // The model can inspect and edit the fixture, and run a fixed sandboxed Node test command.
  // Arbitrary shell, network, browser, and subagent tools are unavailable.
  writeFileSync(join(dir, 'index.mjs'), `
    import { existsSync } from 'node:fs';
    import { basename, join, relative, resolve } from 'node:path';
    import { runIsolatedTests } from ${JSON.stringify(pathToFileURL(join(suite, 'sandbox.mjs')).href)};
    import { BUILTIN_TOOLS, parsePatch } from ${JSON.stringify(pathToFileURL(join(root, 'packages/core/dist/index.js')).href)};
    const scopes = ${JSON.stringify(Object.fromEntries(taskDirs.map(id => [id, JSON.parse(readFileSync(join(suite, id, 'allow.json'), 'utf8'))])))};
    const allowed = new Set(['list_dir', 'read_file', 'grep', 'glob', 'repo_map', 'write_file', 'edit_file', 'apply_patch', 'verify_fixture']);
    export default api => {
      api.registerMode({ ...${JSON.stringify({ id, label, description, prompt: codingPrompt })}, allowTool: tool => allowed.has(tool.name) });
      for (const name of ['write_file', 'edit_file', 'apply_patch']) {
        const tool = BUILTIN_TOOLS.find(item => item.name === name);
        api.registerTool({
          ...tool,
          execute(args, context) {
            const scope = Object.keys(scopes).find(id => basename(context.cwd).startsWith('sun-eval-' + id + '-'));
            const targets = name === 'apply_patch'
              ? parsePatch(String(args.patch ?? '')).flatMap(op => op.moveTo ? [op.path, op.moveTo] : [op.path])
              : [String(args.path ?? '')];
            if (!scope || !targets.length || targets.some(path => !scopes[scope].includes(relative(context.cwd, resolve(context.cwd, path))))) {
              throw new Error('Write refused outside the task card file scope.');
            }
            return tool.execute(args, context);
          },
        });
      }
      api.registerTool({
        name: 'verify_fixture', description: 'Run the fixed offline tests in this fixture repository.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read',
        execute(_, context) {
          const files = ['test/visible.test.mjs'];
          if (existsSync(join(context.cwd, 'test/additions.test.mjs'))) files.push('test/additions.test.mjs');
          const result = runIsolatedTests(context.cwd, files);
          return \`Exit \${result.status ?? 1}\\n\${result.stdout ?? ''}\${result.stderr ?? ''}\`.slice(0, 7000);
        },
      });
    };
  `);
}

function collectDiff(workspace) {
  if (!workspace || !existsSync(workspace)) return '';
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 256 * 1024 });
  const extra = git('ls-files', '--others', '-z').split('\0').filter(path => path && !path.startsWith('.eval-hidden/'));
  if (extra.length) git('add', '--intent-to-add', '--', ...extra);
  const base = git('rev-list', '--max-parents=0', 'HEAD').trim();
  return git('diff', '--no-ext-diff', '--binary', base, '--');
}

let host;
const workspaces = new Set();
try {
  cpSync(fixtureSource, suite, { recursive: true });
  for (const id of taskDirs) {
    const file = join(suite, id, 'task.json');
    const task = JSON.parse(readFileSync(file, 'utf8'));
    if (task.prompt !== '$SETTINGS_HANDOFF') throw new Error(`Task ${id} changed the handoff prompt.`);
    json(file, { ...task, prompt });
  }
  const validation = validateSuite(suite);
  for (const task of validation) console.log(`Fixture ${task.id}: untouched fails=${task.failsUntouched}, reference passes=${task.solvable}`);
  if (validation.length !== 3 || validation.some(task => !task.ok || task.solvable !== true)) {
    console.error(validation.filter(task => !task.ok || task.solvable !== true));
    process.exitCode = 1;
  } else if (!values.validate) {
    const current = loadConfig();
    if (!availableModels(current).includes(values.model)) throw new Error('The selected model is not configured and ready.');
    const { provider } = parseModelRef(values.model);
    const selected = current.providers[provider];
    const sensitive = [providerKey(selected), ...Object.values(selected.headers ?? {})].filter(value => typeof value === 'string' && value.length >= 8);
    const sanitize = value => sensitive.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
    const out = resolve(values.out);
    mkdirSync(out);
    const progress = {
      checkpoint: values.checkpoint, model: values.model,
      modelVersion: parseModelRef(values.model).model,
      providerRevision: 'not reported by the provider adapter',
      startedAt: new Date().toISOString(), promptSha256, suiteSha256,
      repetitions: 3, expectedAttempts: 9, validation, attempts: [], result: 'running',
    };
    json(join(out, 'report.json'), progress);
    makePlugin();
    process.env.SUN_HOME = state;
    const defaults = defaultConfig();
    const config = {
      ...defaults, providers: { [provider]: selected }, defaultModel: values.model, fallbackModels: [], maxSteps: 16,
      titles: 'first-message', memory: { ...defaults.memory, recallModes: [], autoExtract: false },
      lsp: { ...defaults.lsp, enabled: false }, verify: { ...defaults.verify, enabled: false },
    };
    host = new HarnessHost({ config, providerFactory: createProviderFactory(config), connectMcp: false, shellHooks: false });
    await host.init();
    for (let repeat = 1; repeat <= 3; repeat++) {
      await runEval({
        host, suiteDir: suite, suite: 'settings-qualification', label: `${values.checkpoint}-${repeat}`,
        model: values.model, concurrency: 2, timeoutMs: 150_000,
        onResult(result) {
          if (result.workspace) workspaces.add(result.workspace);
          const prefix = `${result.id}-${repeat}`;
          const diff = collectDiff(result.workspace);
          const acceptance = sanitize(result.checkOutput);
          const passed = result.passed && result.status === 'idle' && sanitize(diff) === diff && acceptance === result.checkOutput;
          const diffFile = `${prefix}.diff`;
          const acceptanceFile = `${prefix}.txt`;
          writeFileSync(join(out, diffFile), sanitize(diff));
          writeFileSync(join(out, acceptanceFile), acceptance);
          progress.attempts.push({
            task: result.id, repetition: repeat, attempt: 1, status: result.status,
            reason: result.reason ? sanitize(result.reason) : undefined, durationMs: result.durationMs,
            inputTokens: result.inputTokens, outputTokens: result.outputTokens, toolCalls: result.toolCalls,
            passed, diffFile, acceptanceFile,
          });
          json(join(out, 'report.json'), progress);
          console.log(`${prefix}: ${passed ? 'PASS' : 'FAIL'} (${result.status}, ${result.durationMs} ms)`);
        },
      });
    }
    progress.finishedAt = new Date().toISOString();
    progress.passed = progress.attempts.filter(attempt => attempt.passed).length;
    progress.result = progress.passed === progress.expectedAttempts ? 'pass' : 'fail';
    json(join(out, 'report.json'), progress);
    console.log(`Qualification: ${progress.passed}/${progress.expectedAttempts} passed.`);
    process.exitCode = progress.result === 'pass' ? 0 : 1;
  }
} finally {
  await host?.dispose();
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
