import type { HookDefinition, HookDiagnostic, HookEvent, HookFixture, HookFixtureResult, HookInspection, HookRunState, HookTrustChange } from '@sun/core';
import { useEffect, useLayoutEffect, useState } from 'react';
import { api } from '../api';
import { t, tk } from '../i18n';

const events: Record<HookEvent, string> = {
  sessionStart: tk('Session start'), preToolUse: tk('Before tool use'), postToolUse: tk('After tool use'), stop: tk('Session stop'),
};
const states: Record<HookRunState, string> = {
  completed: tk('Completed'), 'timed-out': tk('Timed out'), cancelled: tk('Cancelled'),
  'output-limit': tk('Output limit exceeded'), 'input-limit': tk('Input limit exceeded'),
  'spawn-failed': tk('Could not start the hook'), 'sandbox-error': tk('Hook sandbox unavailable'),
  'cleanup-failed': tk('Could not confirm hook cleanup'),
};
const issues: Record<HookDiagnostic['code'], string> = {
  INVALID_SOURCE: tk('Invalid hook source'), INVALID_SECTION: tk('Invalid event section'), UNKNOWN_EVENT: tk('Unknown hook event'),
  INVALID_ENTRY: tk('Invalid hook entry'), INVALID_MATCHER: tk('Invalid or unsupported matcher'),
  DUPLICATE_ID: tk('Duplicate hook ID'), TRUST_STORE_INVALID: tk('Invalid hook trust store'),
};

export const hookEventLabel = (event: HookEvent) => t(events[event]);
export const hookRunLabel = (state: HookRunState) => t(states[state]);

function title(hook: HookDefinition) {
  return hook.explicitId ?? t('{event} #{n}', { event: hookEventLabel(hook.event), n: hook.position + 1 });
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('HOOK_REVIEW_STALE')) return t('The hook changed. Reload and review the latest definition.');
  if (message.includes('HOOK_WORKSPACE_REQUIRED')) return t('Choose an existing absolute workspace on the execution host.');
  if (message.includes('HOOK_FIXTURE_DENIED')) return t('Review the hook and choose a matching fixture before running it.');
  return t('The hook operation could not be completed.');
}

export function HooksPanel({ workspace, reportActivity }: {
  workspace?: string;
  reportActivity(dirty: boolean, saving: boolean): void;
}) {
  const [cwd, setCwd] = useState(workspace ?? '');
  const [inspection, setInspection] = useState<HookInspection>();
  const [review, setReview] = useState<string[]>([]);
  const [hookId, setHookId] = useState('');
  const [fixture, setFixture] = useState<HookFixture>('read');
  const [result, setResult] = useState<HookFixtureResult>();
  const [working, setWorking] = useState(false);
  const [runningId, setRunningId] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const [message, setMessage] = useState('');
  const activeHook = inspection?.hooks.find(hook => hook.id === hookId) ?? inspection?.hooks[0];
  const busy = working || !!runningId;

  useEffect(() => {
    if (workspace) return;
    let cancelled = false;
    void api.appInfo().then(info => {
      if (!cancelled) setCwd(current => current || info.defaultCwd);
    }, () => undefined);
    return () => { cancelled = true; };
  }, [workspace]);
  useLayoutEffect(() => reportActivity(false, busy), [busy, reportActivity]);
  useLayoutEffect(() => () => reportActivity(false, false), [reportActivity]);

  function reset() {
    setInspection(undefined);
    setReview([]);
    setResult(undefined);
    setMessage('');
  }

  async function load() {
    if (busy || !cwd.trim()) return;
    reset();
    setWorking(true);
    try { setInspection(await api.listHooks(cwd.trim())); }
    catch (error) { setMessage(failure(error)); }
    finally { setWorking(false); }
  }

  async function apply(changes: HookTrustChange[]) {
    if (busy || !changes.length) return;
    setWorking(true);
    setMessage('');
    setResult(undefined);
    try {
      setInspection(await api.reviewHooks(cwd.trim(), changes));
      setReview([]);
      setMessage(t('Hook review saved.'));
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setWorking(false);
    }
  }

  async function test(execute: boolean) {
    if (!activeHook || busy || (execute && (!result?.matches || result.hook.status !== 'trusted'))) return;
    if (execute && !window.confirm(t('Run the reviewed hook in the selected workspace?'))) return;
    const requestId = execute
      ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
      : undefined;
    if (requestId) {
      setRunningId(requestId);
      setCancelled(false);
    } else setWorking(true);
    setMessage('');
    try {
      setResult(await api.runHookFixture({ cwd: cwd.trim(), id: activeHook.id, digest: activeHook.digest, fixture, execute, requestId }));
    } catch (error) {
      setMessage(failure(error));
      setResult(undefined);
    } finally {
      if (requestId) setRunningId(undefined);
      else setWorking(false);
    }
  }

  async function cancel() {
    if (!runningId || cancelled) return;
    setCancelled(true);
    try { await api.cancelHookFixture(runningId); }
    catch {
      setCancelled(false);
      setMessage(t('Could not request hook cancellation.'));
    }
  }

  return (
    <>
      <form className="card settings-fields" onSubmit={event => { event.preventDefault(); void load(); }}>
        <p className="muted small">{t('Hooks need review on this execution host. Changes to a source file require another review.')}</p>
        <label htmlFor="hook-workspace">{t('Hook workspace')}</label>
        <input id="hook-workspace" value={cwd} disabled={busy} onChange={event => { setCwd(event.target.value); reset(); }} />
        <button type="submit" className="btn-ghost" disabled={busy || !cwd.trim()}>{t('Load hooks')}</button>
      </form>
      {inspection && (
        <>
          <section className="card settings-fields">
            <h3>{t('Hook trust')}</h3>
            {!inspection.hooks.length && <p>{t('No hooks found in this workspace.')}</p>}
            {inspection.diagnostics.length > 0 && <ul className="data-items">
              {inspection.diagnostics.map((issue, index) => <li key={index}>
                <strong>{t(issues[issue.code])}</strong> <code>{issue.source}</code>
                {issue.event && <small> · {hookEventLabel(issue.event)}</small>}
                {issue.policy && <p className="err-text">{t('This diagnostic can block tool calls under the hook policy.')}</p>}
              </li>)}
            </ul>}
            <ul className="data-items hook-items">
              {inspection.hooks.map(hook => (
                <li key={hook.id} data-hook-id={hook.id}>
                  <div className="row">
                    {hook.status === 'untrusted' && <label className="row">
                      <input type="checkbox" checked={review.includes(hook.id)} disabled={busy}
                        onChange={event => setReview(previous => event.target.checked ? [...previous, hook.id] : previous.filter(id => id !== hook.id))} />
                      <strong>{title(hook)}</strong>
                    </label>}
                    {hook.status !== 'untrusted' && <strong>{title(hook)}</strong>}
                    <small className="muted">{hook.worktreeSetup ? t('Worktree setup') : hookEventLabel(hook.event)} · {hook.status === 'trusted' ? t('Trusted') : hook.status === 'disabled' ? t('Disabled') : t('Needs review')}</small>
                    {hook.status === 'trusted' && <button type="button" className="btn-ghost" disabled={busy}
                      onClick={() => void apply([{ id: hook.id, digest: hook.digest, trust: false }])}>{t('Revoke trust')}</button>}
                  </div>
                  <small className="muted">{hook.scope === 'user' ? t('User hook') : t('Project hook')} · <code>{hook.source}</code></small>
                  <pre>{hook.command}</pre>
                  {hook.matcher && <p className="muted small">{t('Matcher · {matcher}', { matcher: hook.matcher })}</p>}
                  {hook.onFailure === 'block' && <p className="muted small">{t('Blocks matching tools if the hook fails.')}</p>}
                </li>
              ))}
            </ul>
            <button type="button" className="btn-primary" disabled={busy || !review.length}
              onClick={() => void apply(inspection.hooks.filter(hook => review.includes(hook.id))
                .map(({ id, digest }) => ({ id, digest, trust: true })))}>{t('Trust selected hooks')}</button>
          </section>
          {activeHook && <section className="card settings-fields">
            <h3>{t('Fixture testing')}</h3>
            <label htmlFor="hook-fixture-target">{t('Hook to test')}</label>
            <select id="hook-fixture-target" value={activeHook.id} disabled={busy}
              onChange={event => { setHookId(event.target.value); setResult(undefined); }}>
              {inspection.hooks.map(hook => <option key={hook.id} value={hook.id}>{title(hook)}</option>)}
            </select>
            <label htmlFor="hook-fixture">{t('Synthetic fixture')}</label>
            <select id="hook-fixture" value={fixture} disabled={busy}
              onChange={event => { setFixture(event.target.value as HookFixture); setResult(undefined); }}>
              <option value="read">{t('Read tool fixture')}</option>
              <option value="shell">{t('Shell tool fixture')}</option>
              <option value="edit">{t('File edit fixture')}</option>
            </select>
            <div className="row">
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void test(false)}>{t('Preview fixture')}</button>
              <button type="button" className="btn-primary" disabled={busy || activeHook.worktreeSetup || !result?.matches || result.hook.status !== 'trusted'}
                onClick={() => void test(true)}>{t('Run reviewed hook')}</button>
              {runningId && <button type="button" className="btn-ghost" disabled={cancelled} onClick={() => void cancel()}>{t('Cancel hook run')}</button>}
            </div>
            {result && <>
              <p className="muted small">{result.matches ? t('The hook matches this fixture.') : t('The hook does not match this fixture.')}</p>
              <p className="muted small">{t('Configured sandbox · {mode}', { mode: result.sandbox })}</p>
              <pre data-hook-payload>{JSON.stringify(result.payload, null, 2)}</pre>
              {result.execution && <>
                <p role="status">{t('{state} · exit {code}', { state: hookRunLabel(result.execution.state), code: result.execution.code })}</p>
                {result.execution.stdout && <pre data-hook-stdout>{result.execution.stdout}</pre>}
                {result.execution.stderr && <pre data-hook-stderr>{result.execution.stderr}</pre>}
              </>}
            </>}
          </section>}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
