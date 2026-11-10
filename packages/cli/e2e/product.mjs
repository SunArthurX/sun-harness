// Run after pnpm build with node --test packages/cli/e2e/product.mjs.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const bundle = fileURLToPath(new URL('../dist/sun.mjs', import.meta.url));
const stdioMcp = fileURLToPath(new URL('../../core/test/fixtures/echo-mcp.mjs', import.meta.url));
const ptyRunner = fileURLToPath(new URL('pty-runner.py', import.meta.url));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlE0i8AAAAASUVORK5CYII=';
const requests = [];
let directory;
let workspace;
let environment;
let quota = false;
let rejected = false;
let companyDenied = false;

function respond(response, delta, finish = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
}

function writeTool(content, path = 'fixture.txt') {
  return { tool_calls: [{ index: 0, id: 'fixture-write', type: 'function', function: {
    name: 'write_file', arguments: JSON.stringify({ path, content }),
  } }] };
}

const server = createServer(async (request, response) => {
  const body = [];
  for await (const chunk of request) body.push(chunk);
  const payload = JSON.parse(Buffer.concat(body));
  if (request.url === '/company/search') {
    const accepted = !companyDenied && request.headers.authorization === 'Bearer offline-company-fixture';
    response.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(accepted ? { hits: [{ title: 'Company audit hit', text: payload.query, source: 'fixture://kb', score: 10 }] } : {}));
    return;
  }
  requests.push(payload);
  if (payload.model === 'fixture-asr') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Transcribed audit audio.' } }] }));
    return;
  }
  const user = payload.messages.findLast(message => message.role === 'user');
  const prompt = typeof user?.content === 'string' ? user.content : user?.content.find(part => part.type === 'text')?.text;
  if (quota || rejected) {
    response.writeHead(quota ? 402 : 400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: quota ? 'Fixture quota exhausted' : 'Fixture unsupported argument' } }));
  } else if (prompt === 'exercise approval' || prompt === 'exercise edit') {
    const result = payload.messages.find(message => message.role === 'tool');
    if (result) respond(response, { content: 'Observed fixture result.' });
    else respond(response, writeTool('isolated fixture bytes'), 'tool_calls');
  } else if (prompt?.startsWith('Existing memory:') && prompt.includes('reflect audit session')) {
    respond(response, { content: JSON.stringify([
      { type: 'memory', title: 'Audit accepted fact', content: 'The audit prefers isolated fixtures.', rationale: 'Stated in the session.', section: 'Preferences' },
      { type: 'memory', title: 'Audit rejected fact', content: 'The audit rejects this proposal.', rationale: 'Fixture.', section: 'Preferences' },
    ]) });
  } else if (prompt === 'audit eval fixture' && payload.model === 'one' && !payload.messages.some(message => message.role === 'tool')) {
    respond(response, writeTool('audited answer\n', 'answer.txt'), 'tool_calls');
  } else {
    respond(response, { content: 'Fixture response.' });
  }
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sun-cli-product-'));
  workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  environment = { ...process.env, HOME: directory, SUN_HOME: directory, SUN_NO_GATEWAY: '', TMPDIR: directory, NO_COLOR: '1' };
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    defaultModel: 'fixture/one', fallbackModels: [], titles: 'first-message',
    providers: { fixture: {
      type: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'offline-fixture', models: ['one', 'two'], vision: true,
    } },
  }));
});

after(async () => {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

function invoke(args, { entry = cli, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [entry, ...args], { cwd: workspace, env: environment, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function succeed(args, options) {
  const result = await invoke(args, options);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('built and bundled commands expose help and workspace scaffolding', async () => {
  assert.match(await succeed(['--help'], { entry: bundle }), /sun resume/);
  await succeed(['init']);
  assert.match(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), /AGENTS/);
  assert.match(await succeed(['models']), /fixture\/one/);
  assert.match(await succeed(['modes']), /assistant/);
});

test('run reads stdin, emits stream JSON and reopens the durable session', async () => {
  const stdout = await succeed(['run', '--local', '--output', 'stream-json'], { input: 'cli-stream-fixture' });
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  const result = events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.status, 'idle');
  assert.equal(result.text, 'Fixture response.');
  assert.ok(events.some(event => event.kind === 'delta' && event.text.includes('Fixture response.')));
  assert.ok((await succeed(['sessions', '--local'])).includes(result.sessionId));
  assert.ok((await succeed(['search', 'cli-stream-fixture'])).includes(result.sessionId));
  assert.match(await succeed(['show', result.sessionId]), /cli-stream-fixture[\s\S]*Fixture response\./);
  const context = JSON.parse(await succeed(['context', result.sessionId, '--json']));
  assert.ok(Object.keys(context).length > 0);
  await succeed(['pin', result.sessionId]);
  await succeed(['archive', result.sessionId]);
  assert.ok(!(await succeed(['sessions', '--local'])).includes(result.sessionId));
  assert.ok((await succeed(['sessions', '--local', '--all'])).includes(result.sessionId));
  await succeed(['unarchive', result.sessionId]);
  await succeed(['unpin', result.sessionId]);
});

test('one-shot noninteractive approval denies a write and returns the denial to the model', async () => {
  const result = JSON.parse(await succeed(['run', '--local', '--approval', 'suggest', '--json', 'exercise approval']));
  assert.equal(result.status, 'idle');
  const toolResult = requests.at(-1).messages.find(message => message.role === 'tool');
  assert.match(toolResult.content, /denied|no approver|headless/i);
  await assert.rejects(readFile(join(workspace, 'fixture.txt')), { code: 'ENOENT' });
});

test('a real terminal ignores an early approval and applies a later denial', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('python3', [ptyRunner, process.execPath, cli, 'run', '--local', '--approval', 'suggest', 'exercise approval'], {
    cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let early = false;
  let later;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (!early && output.includes('for this tool:')) {
      early = true;
      child.stdin.write('y\n');
    }
    if (!later && output.includes('ignored input typed before the prompt appeared')) {
      later = setTimeout(() => child.stdin.write('n\n'), 550);
    }
  });
  child.stderr.on('data', chunk => { output += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12_000);
  try {
    const [exit] = await once(child, 'close');
    assert.equal(exit, 0, output);
    assert.match(output, /ignored input typed before the prompt appeared/);
    assert.match(output, /Observed fixture result\./);
    await assert.rejects(readFile(join(workspace, 'fixture.txt')), { code: 'ENOENT' });
  } finally {
    clearTimeout(watchdog);
    clearTimeout(later);
    child.stdin.destroy();
  }
});

test('an approved edit appears in changes and undo restores the workspace', async () => {
  const result = JSON.parse(await succeed(['run', '--local', '--approval', 'auto-edit', '--json', 'exercise edit']));
  assert.equal(await readFile(join(workspace, 'fixture.txt'), 'utf8'), 'isolated fixture bytes');
  const changes = JSON.parse(await succeed(['changes', result.sessionId, '--json']));
  assert.ok(JSON.stringify(changes).includes('fixture.txt'));
  await succeed(['undo', result.sessionId, '--local']);
  await assert.rejects(readFile(join(workspace, 'fixture.txt')), { code: 'ENOENT' });
});

test('quota pauses with exit 3 and a later process resumes on the selected model', async () => {
  quota = true;
  let paused;
  try {
    paused = await invoke(['run', '--local', '--json', 'quota fixture']);
  } finally {
    quota = false;
  }
  assert.equal(paused.code, 3, paused.stderr || paused.stdout);
  const result = JSON.parse(paused.stdout);
  assert.equal(result.reason, 'quota');
  assert.match(await succeed(['resume', result.sessionId, '--local', '--model', 'fixture/two']), /idle/);
  assert.equal(requests.at(-1).model, 'two');
  assert.ok(requests.at(-1).messages.some(message => message.content === 'quota fixture'));
});

test('a terminal provider error returns exit 1 for both run and resume', async () => {
  rejected = true;
  try {
    const run = await invoke(['run', '--local', '--json', 'terminal fixture']);
    assert.equal(run.code, 1, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'error');
    const resumed = await invoke(['resume', result.sessionId, '--local']);
    assert.match(resumed.stdout, /error/);
    assert.equal(resumed.code, 1, 'a terminal error is distinct from a paused run');
  } finally {
    rejected = false;
  }
});

test('CLI image input reaches the provider and a portable bundle restores its attachment', async () => {
  const image = join(directory, 'pixel.png');
  const archive = join(directory, 'fixture.sunbundle');
  await writeFile(image, Buffer.from(png, 'base64'));
  const result = JSON.parse(await succeed(['run', '--local', '--json', '--image', image, 'fixture image']));
  const modelImage = requests.at(-1).messages.findLast(message => message.role === 'user').content.find(part => part.type === 'image_url');
  assert.equal(modelImage.image_url.url, `data:image/png;base64,${png}`);
  await succeed(['export', result.sessionId, '--local', '--format', 'bundle', '-o', archive]);
  const imported = await succeed(['import', archive, '--local', '--cwd', workspace]);
  const restored = imported.match(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/i)?.[0];
  assert.ok(restored, imported);
  assert.notEqual(restored, result.sessionId);
  const transcript = await succeed(['export', restored, '--local', '--format', 'jsonl']);
  assert.match(transcript, /fixture image/);
  assert.match(transcript, /image\/png/);
});

test('MCP inspection exits after closing a successfully connected stdio server', async () => {
  const config = join(workspace, '.mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [stdioMcp] } } }));
  try {
    assert.match(await succeed(['mcp', '--cwd', workspace]), /fixture[^\n]*echo, slow/);
  } finally {
    await rm(config);
  }
});

test('interactive command loop buffers piped follow-ups and applies mode and model switches', async () => {
  const output = await succeed(['chat', '--local'], { input: '/mode assistant\n/model fixture/two\nfirst audit message\nsecond audit message\n/exit\n' });
  assert.match(output, /Mode → assistant/);
  assert.match(output, /Model → fixture\/two/);
  assert.equal(output.match(/Fixture response\./g)?.length, 2);
  assert.ok(requests.at(-1).messages.some(message => message.content === 'first audit message'));
  assert.equal(requests.at(-1).messages.findLast(message => message.role === 'user').content, 'second audit message');
});

test('CLI lists project commands and skills, expands arguments, and attaches a mentioned file', async () => {
  const commands = join(workspace, '.sun', 'commands');
  const skills = join(workspace, '.sun', 'skills', 'audit-skill');
  await mkdir(commands, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(join(commands, 'audit-check.md'), '---\ndescription: Check the fixture\nargument-hint: <topic>\n---\nExpand audit topic $1.\n');
  await writeFile(join(skills, 'SKILL.md'), '---\nname: audit-skill\ndescription: Isolated skills test\n---\nUse the fixture workspace.\n');
  await writeFile(join(workspace, 'audit-reference.txt'), 'Audit file mention bytes.');
  assert.match(await succeed(['commands', '--cwd', workspace]), /audit-check.*<topic>/);
  assert.match(await succeed(['skills', '--cwd', workspace]), /audit-skill.*Isolated skills test/);
  const start = requests.length;
  await succeed(['chat', '--local', '--cwd', workspace], { input: '/audit-check sunlight\nRead @audit-reference.txt\n/exit\n' });
  const wire = JSON.stringify(requests.slice(start));
  assert.match(wire, /Expand audit topic sunlight\./);
  assert.match(wire, /Audit file mention bytes\./);
});

test('interactive slash commands inspect, revert, report, export and rewind a session', async () => {
  const exported = join(directory, 'slash-export.jsonl');
  const start = requests.length;
  const input = [
    'exercise edit', '/changes', '/diff fixture.txt', '/revert fixture.txt', '/undo', '/review', '/context', '/cost',
    '/compact', `/export jsonl ${exported}`, '/sessions', '/reflect', '/help', '/rewind', '/rewind 1', '/not-a-command', '/exit',
  ].join('\n');
  try {
    const output = await succeed(['chat', '--local', '--approval', 'auto-edit'], { input: `${input}\n` });
    assert.match(output, /Observed fixture result\./);
    assert.match(output, /fixture\.txt/);
    assert.match(output, /\+isolated fixture bytes/);
    assert.match(output, /Reverted fixture\.txt to its state before this session/);
    assert.match(output, /✗ \/reflect failed: Reflection returned no JSON proposals: Fixture response\./);
    assert.match(output, /Exported to .*slash-export\.jsonl/);
    assert.match(output, /\/rewind/);
    assert.match(output, /\s1\s+exercise edit/);
    assert.match(output, /The review could not be completed\. Run Review again\./);
    assert.match(output, /Context · fixture\/one · [\d.]+k \/ 128k tokens/);
    assert.match(output, /Compacted older history into a summary\./);
    assert.match(output, /Rewound into session \d{8}-[0-9a-f]{8}\. Message 1 was:/);
    assert.match(output, /Unknown command \/not-a-command/);
    assert.equal(await readFile(join(workspace, 'fixture.txt'), 'utf8'), 'isolated fixture bytes', '/undo restores the reverted edit');
    const log = (await readFile(exported, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(log.some(event => event.type === 'file/revert'));
    assert.ok(log.some(event => event.type === 'review/request'));
    const review = log.findLast(event => event.type === 'review/report')?.review;
    assert.deepEqual({ state: review?.state, error: review?.error, findings: review?.findings }, { state: 'failed', error: 'INVALID_RESPONSE', findings: [] });
    assert.ok(requests.slice(start).some(payload => JSON.stringify(payload).includes('+isolated fixture bytes')), '/review sends the session diff');
  } finally {
    await rm(join(workspace, 'fixture.txt'), { force: true });
  }
});

test('knowledge and memory commands persist and retrieve distinct CJK content', async () => {
  await succeed(['kb', 'add', 'Solar fixture', '-'], { input: '光伏组件性能测试和隔离验证。' });
  assert.match(await succeed(['kb', 'search', '光伏组件']), /Solar fixture[\s\S]*光伏组件/);
  assert.match(await succeed(['kb', 'index']), /Hybrid retrieval is off/);
  const added = await succeed(['memory', 'add', '倾向使用独立测试目录']);
  const id = added.match(/Added ([\w-]+)/)?.[1];
  assert.ok(id, added);
  assert.match(await succeed(['memory', 'search', '独立测试']), /倾向使用独立测试目录/);
  await succeed(['memory', 'rm', id]);
  assert.doesNotMatch(await succeed(['memory', 'list']), /倾向使用独立测试目录/);
});

test('configured company knowledge sends a bearer token and keeps local search on a remote denial', async () => {
  const file = join(directory, 'config.json');
  const saved = await readFile(file, 'utf8');
  const previousEnv = environment;
  const config = JSON.parse(saved);
  config.kb = { company: { enabled: true, name: 'Company fixture', baseUrl: `http://127.0.0.1:${server.address().port}/company/`, tokenEnv: 'SUN_COMPANY_TEST_TOKEN' } };
  environment = { ...environment, SUN_COMPANY_TEST_TOKEN: 'offline-company-fixture' };
  await writeFile(file, JSON.stringify(config));
  try {
    await succeed(['kb', 'add', 'Fallback local note', '-'], { input: 'Audit recovery entries.' });
    const both = await succeed(['kb', 'search', 'Audit recovery']);
    assert.match(both, /Company audit hit/);
    assert.match(both, /Fallback local note/);
    companyDenied = true;
    const fallback = await succeed(['kb', 'search', 'Audit recovery']);
    assert.match(fallback, /Fallback local note/);
    assert.match(fallback, /Company fixture error[\s\S]*HTTP 401/);
    assert.doesNotMatch(both + fallback, /offline-company-fixture/);
  } finally {
    companyDenied = false;
    environment = previousEnv;
    await writeFile(file, saved);
  }
});

test('mail and calendar presets update isolated MCP and untrusted-tool settings without opening accounts', async () => {
  const config = join(directory, 'config.json');
  const mcp = join(directory, 'mcp.json');
  const saved = await readFile(config, 'utf8');
  const presets = ['gmail', 'google-calendar', 'outlook', 'apple'];
  try {
    const list = await succeed(['mcp', 'presets']);
    for (const name of presets) {
      assert.ok(list.includes(name));
      assert.ok((await succeed(['mcp', 'add', name, '--local'])).includes(`Added ${name}`));
    }
    const settings = JSON.parse(await readFile(config, 'utf8'));
    const servers = JSON.parse(await readFile(mcp, 'utf8')).mcpServers;
    for (const name of presets) {
      assert.equal(servers[name].command, 'npx');
      assert.ok(settings.taint.untrusted.includes(`mcp__${name}__*`));
    }
    const unknown = await invoke(['mcp', 'add', 'unknown-fixture', '--local']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown preset/);
  } finally {
    await rm(mcp, { force: true });
    await writeFile(config, saved);
  }
});

test('voice transcribe and record use a controlled audio source and the configured ASR provider', async () => {
  const file = join(directory, 'config.json');
  const saved = await readFile(file, 'utf8');
  const previousEnv = environment;
  const fixtureBin = join(directory, 'audio-bin');
  const audio = 'ID3audit-audio';
  const sample = join(directory, 'sample.mp3');
  await mkdir(fixtureBin);
  await writeFile(sample, audio);
  await writeFile(join(fixtureBin, 'ffmpeg'), '#!/bin/sh\nfor last do :; done\nprintf "%s" "ID3audit-audio" > "$last"\n', { mode: 0o755 });
  environment = { ...environment, PATH: `${fixtureBin}:${environment.PATH}` };
  await writeFile(file, JSON.stringify({ ...JSON.parse(saved), voice: { enabled: true, stt: 'fixture/fixture-asr' } }));
  try {
    for (const args of [['transcribe', sample], ['record', '--seconds', '1']]) {
      assert.match(await succeed(['voice', ...args]), /Transcribed audit audio\./);
      const message = requests.at(-1).messages.find(item => item.role === 'user');
      assert.equal(message.content.find(item => item.type === 'input_audio').input_audio.data, `data:audio/mpeg;base64,${Buffer.from(audio).toString('base64')}`);
    }
  } finally {
    environment = previousEnv;
    await writeFile(file, saved);
  }
});

test('sandbox self-test succeeds for completed probes and fails when the shell cannot run', async () => {
  const config = join(directory, 'config.json');
  const saved = await readFile(config, 'utf8');
  const previousEnv = environment;
  const fixtureBin = join(directory, 'sandbox-bin');
  await mkdir(fixtureBin);
  await writeFile(join(fixtureBin, 'bash'), '#!/bin/sh\nprintf "%s\\n" "fixture shell failed" >&2\nexit 23\n', { mode: 0o755 });
  await writeFile(config, JSON.stringify({ ...JSON.parse(saved), sandbox: { mode: 'off' } }));
  try {
    assert.match(await succeed(['sandbox', 'status']), /mode off/);
    const probes = await succeed(['sandbox', 'test']);
    assert.match(probes, /\bok\b/);
    assert.match(probes, /OUTSIDE-WRITABLE/);
    environment = { ...environment, PATH: `${fixtureBin}:${environment.PATH}` };
    const failed = await invoke(['sandbox', 'test']);
    assert.match(failed.stdout + failed.stderr, /fixture shell failed/);
    assert.equal(failed.code, 1, 'a failing shell must not produce a successful self-test');
  } finally {
    environment = previousEnv;
    await writeFile(config, saved);
  }
});

test('automation commands preview, persist, edit, pause, run, track history and delete', async () => {
  assert.match(await succeed(['automations', 'preview', '每天晚上8点']), /0 20 \* \* \*/);
  const added = await succeed(['automations', 'add', 'every weekday at 9am', 'audit scheduled run']);
  const id = added.match(/\b[\da-f]{8}\b/)?.[0];
  assert.ok(id, added);
  assert.match(await succeed(['automations', 'pause', id]), /○/);
  assert.match(await succeed(['automations', 'resume', id]), /●/);
  assert.match(await succeed(['automations', 'edit', id, '--title', 'Audit schedule updated']), /Audit schedule updated/);
  assert.match(await succeed(['automations', 'run', id]), /Fixture response\./);
  assert.match(await succeed(['automations', 'history', id]), /idle/);
  await succeed(['automations', 'rm', id]);
  assert.doesNotMatch(await succeed(['automations', 'list']), /Audit schedule updated/);
});

test('intel defaults to the local calendar day for listing, showing, and retrying saved analysis', async () => {
  const raw = join(directory, 'intel', 'raw');
  const reports = join(directory, 'intel', 'reports');
  const clock = join(directory, 'clock.cjs');
  await mkdir(raw, { recursive: true });
  await mkdir(reports, { recursive: true });
  await writeFile(join(raw, '2026-11-08.json'), JSON.stringify({ items: [], errors: [] }));
  await writeFile(clock, `const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-11-07T13:30:00Z'])); }
      static now() { return RealDate.parse('2026-11-07T13:30:00Z'); }
    };
  `);
  const previousEnv = environment;
  environment = { ...environment, TZ: 'Pacific/Kiritimati', NODE_OPTIONS: `--require=${clock}` };
  try {
    assert.match(await succeed(['intel', 'analyze']), /2026-11-08\.md/);
    assert.match(await succeed(['intel', 'list']), /2026-11-08/);
    assert.match(await succeed(['intel', 'show']), /No items\./);
    const invalid = await invoke(['intel', 'show', '../outside']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /calendar date/i);
  } finally {
    environment = previousEnv;
  }
});

test('worktree commands isolate an edit, report its diff, squash it, and clean a separate worktree', async () => {
  const repo = join(directory, 'worktree-repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: environment, encoding: 'utf8' });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.name', 'Audit fixture');
  git('config', 'user.email', 'audit@example.test');
  await writeFile(join(repo, 'README.md'), '# Fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'Initial fixture');
  const run = async prompt => JSON.parse(await succeed(['run', '--local', '--cwd', repo, '--worktree', '--approval', 'auto-edit', '--json', prompt]));
  const changed = await run('exercise edit');
  await assert.rejects(readFile(join(repo, 'fixture.txt')), { code: 'ENOENT' });
  assert.match(await succeed(['worktree', 'list', '--local']), new RegExp(changed.sessionId));
  assert.match(await succeed(['worktree', 'status', changed.sessionId, '--local']), /fixture\.txt/);
  assert.match(await succeed(['worktree', 'diff', changed.sessionId, '--local']), /\+isolated fixture bytes/);
  await succeed(['worktree', 'merge', changed.sessionId, '--local', '--strategy', 'squash']);
  assert.equal(await readFile(join(repo, 'fixture.txt'), 'utf8'), 'isolated fixture bytes');
  assert.match(git('diff', '--cached', '--name-only'), /fixture\.txt/);
  git('commit', '-qm', 'Squash fixture');
  const clean = await run('leave this worktree clean');
  const preview = JSON.parse(await succeed(['worktree', 'preview', clean.sessionId, '--local']));
  assert.equal(typeof preview.revision, 'string');
  const item = preview.items.find(entry => entry.id === clean.sessionId);
  assert.equal(item?.state, 'ready');
  assert.ok(git('worktree', 'list', '--porcelain').includes(item.path));
  const cleanup = JSON.parse(await succeed(['worktree', 'cleanup', preview.revision, clean.sessionId, '--local']));
  assert.deepEqual(cleanup.removed.map(entry => entry.id), [clean.sessionId]);
  assert.ok(!git('worktree', 'list', '--porcelain').includes(item.path));
});

test('eval runs a hidden check and compares a passing scripted run with a regression', async () => {
  const suite = join(directory, 'eval-suite');
  const task = join(suite, 'audit-task');
  await mkdir(join(task, 'repo'), { recursive: true });
  await mkdir(join(task, 'hidden'));
  await writeFile(join(task, 'task.json'), JSON.stringify({ id: 'audit-task', title: 'Audit fixture', category: 'feature', language: 'text', prompt: 'audit eval fixture' }));
  await writeFile(join(task, 'check.sh'), 'set -eu\ncmp answer.txt .eval-hidden/answer.txt\n');
  await writeFile(join(task, 'hidden', 'answer.txt'), 'audited answer\n');
  const options = ['--suite', suite, '--concurrency', '1'];
  assert.match(await succeed(['eval', 'run', ...options, '--model', 'fixture/one', '--label', 'audit-pass']), /100\.0%/);
  assert.match(await succeed(['eval', 'run', ...options, '--model', 'fixture/two', '--label', 'audit-fail']), /0\.0%/);
  assert.match(await succeed(['eval', 'report', 'audit-pass']), /audit-task.*pass/);
  assert.match(await succeed(['eval', 'compare', 'audit-pass', 'audit-fail']), /audit-task.*regressed/);
  const history = await succeed(['eval', 'list']);
  assert.match(history, /\s100\.0%\s/);
  assert.match(history, /\s0\.0%\s/);
  const runs = await Promise.all((await readdir(join(directory, 'evals'))).map(async file => JSON.parse(await readFile(join(directory, 'evals', file), 'utf8'))));
  const passing = runs.find(run => run.label === 'audit-pass');
  const [result] = passing.results;
  assert.deepEqual({ id: result.id, passed: result.passed, steps: result.steps, toolCalls: result.toolCalls, editCalls: result.editCalls, toolErrors: result.toolErrors, writes: result.byTool.write_file },
    { id: 'audit-task', passed: true, steps: 2, toolCalls: 1, editCalls: 1, toolErrors: 0, writes: { calls: 1, errors: 0 } });
  assert.equal(passing.summary.passRate, 1);
  assert.equal(runs.find(run => run.label === 'audit-fail').results[0].passed, false);
});

test('serve owns CLI sessions, isolates local routing, and creates removable launch-agent metadata', async () => {
  const portProbe = createServer();
  const listening = once(portProbe, 'listening');
  portProbe.listen(0, '127.0.0.1');
  await listening;
  const { port } = portProbe.address();
  await new Promise(resolve => portProbe.close(resolve));
  const gateway = spawn(process.execPath, [cli, 'serve', '--port', String(port)], {
    cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout.resume();
  gateway.stderr.resume();
  const exited = once(gateway, 'exit');
  const bin = join(directory, 'fixture-bin');
  const launchLog = join(directory, 'launch-operations');
  const plist = join(directory, 'Library', 'LaunchAgents', 'com.sun-harness.gateway.plist');
  try {
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    let metadata;
    for (let attempt = 0; attempt < 100 && gateway.exitCode === null; attempt++) {
      const text = await readFile(join(directory, 'gateway.json'), 'utf8').catch(() => undefined);
      if (text) {
        metadata = JSON.parse(text);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(metadata, 'the CLI gateway must write isolated discovery metadata');
    assert.equal((await fetch(healthUrl)).status, 401);
    assert.equal((await fetch(healthUrl, { headers: { authorization: `Bearer ${metadata.token}` } })).status, 200);
    assert.match(await succeed(['gateway', 'status']), /running at/);
    const remote = JSON.parse(await succeed(['run', '--json', 'automatic gateway fixture']));
    assert.equal(remote.status, 'idle');
    const requestsBeforeChat = requests.length;
    const remoteChat = await succeed(['chat'], { input: '/mode assistant\nremote pipe audit message\n/exit\n' });
    assert.match(remoteChat, /via gateway/);
    assert.match(remoteChat, /Mode → assistant/);
    assert.match(remoteChat, /Fixture response\./);
    assert.ok(requests.slice(requestsBeforeChat).some(payload => payload.messages.some(message => message.role === 'user' && message.content === 'remote pipe audit message')));
    const local = await succeed(['chat', '--local'], { input: '/exit\n' });
    assert.doesNotMatch(local, /via gateway/);
    await mkdir(bin);
    await writeFile(join(bin, 'launchctl'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SUN_FIXTURE_LAUNCH_LOG"\n', { mode: 0o755 });
    const oldEnv = environment;
    environment = { ...environment, PATH: `${bin}:${environment.PATH}`, SUN_FIXTURE_LAUNCH_LOG: launchLog };
    try {
      await succeed(['gateway', 'install', '--port', String(port)]);
      const xml = await readFile(plist, 'utf8');
      assert.match(xml, /com\.sun-harness\.gateway/);
      assert.match(xml, new RegExp(`<string>${port}</string>`));
      await succeed(['gateway', 'uninstall']);
      await assert.rejects(readFile(plist), { code: 'ENOENT' });
      assert.deepEqual((await readFile(launchLog, 'utf8')).trim().split('\n'), ['unload', 'load', 'unload']);
    } finally {
      environment = oldEnv;
    }
  } finally {
    if (gateway.exitCode === null) gateway.kill('SIGTERM');
    const killTimer = setTimeout(() => gateway.kill('SIGKILL'), 4000);
    await exited;
    clearTimeout(killTimer);
  }
});

test('management commands review proposals, report context and metrics, and manage tokens and grants', async () => {
  const session = JSON.parse(await succeed(['run', '--local', '--json', 'reflect audit session']));
  const reflected = await succeed(['evolve', 'reflect', session.sessionId]);
  const ids = [...reflected.matchAll(/^(\S+)\s+\[memory\] Audit (accepted|rejected) fact$/gm)].map(match => match[1]);
  assert.equal(ids.length, 2, reflected);
  assert.match(await succeed(['evolve', 'accept', ids[0]]), /Applied → /);
  assert.match(await succeed(['evolve', 'reject', ids[1]]), /Rejected\./);
  const proposals = await succeed(['evolve', 'list']);
  assert.match(proposals, new RegExp(`${ids[0]}\\s+accepted\\s+\\[memory\\] Audit accepted fact`));
  assert.match(proposals, new RegExp(`${ids[1]}\\s+rejected\\s+\\[memory\\] Audit rejected fact`));
  assert.match(await readFile(join(directory, 'memory', 'MEMORY.md'), 'utf8'), /The audit prefers isolated fixtures\./);

  const report = join(directory, 'context-report.html');
  await succeed(['context', session.sessionId, '--format', 'html', '-o', report]);
  assert.match(await readFile(report, 'utf8'), /^<!doctype html>[\s\S]*reflect audit session/i);
  assert.match(await succeed(['metrics', '--days', '7']), /Conversation efficiency \(last 7 days\)[\s\S]*\| coding \|/);

  const created = await succeed(['gateway', 'token', 'create', 'audit-device']);
  assert.match(created, /sund_[\w-]{32}/);
  assert.match(await succeed(['gateway', 'token', 'list']), /audit-device/);
  assert.match(await succeed(['gateway', 'token', 'revoke', 'audit-device']), /Revoked\./);
  assert.doesNotMatch(await succeed(['gateway', 'token', 'list']), /audit-device/);

  const grant = JSON.parse(await succeed(['browser', 'permissions', 'set', 'https://audit.example', 'upload', 'deny', '--local']));
  assert.deepEqual(grant.snapshot.rules, [{ origin: 'https://audit.example', action: 'upload', decision: 'deny' }]);
  assert.equal(JSON.parse(await succeed(['browser', 'permissions', '--local'])).revision, grant.snapshot.revision);
  assert.match(await succeed(['browser', 'status']), /mode local/);
  assert.deepEqual(JSON.parse(await succeed(['hooks', 'list', '--local'])).hooks, []);
  assert.match(await succeed(['trigger', 'list']), /No triggers/);
  assert.match(await succeed(['remote', 'list']), /No remotes/);
  assert.match(await succeed(['doctor']), /Default model: [^\n]*fixture\/one/);
});
