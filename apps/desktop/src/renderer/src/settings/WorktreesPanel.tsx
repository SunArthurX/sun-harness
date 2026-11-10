import type { HookDefinition, WorktreeCleanupPreview, WorktreeInventoryItem, WorktreeSetupState, WorktreeState } from '@sun/core';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { t, tk } from '../i18n';

const states: Record<WorktreeState, string> = {
  ready: tk('Ready'), active: tk('Active'), dirty: tk('Has uncommitted files'), unowned: tk('Ownership could not be verified'),
  missing: tk('Workspace missing'), closed: tk('Closed'), recovery: tk('Recovery required'),
};
const setupStates: Record<WorktreeSetupState, string> = {
  'not-started': tk('Setup has not run'), running: tk('Setup is running'), completed: tk('Setup completed'),
  failed: tk('Setup failed'), interrupted: tk('Setup was interrupted'), acknowledged: tk('Setup interruption acknowledged'),
};

export function worktreeError(error: unknown): string {
  const message = String(error);
  if (message.includes('WORKTREE_ACTIVE')) return t('Wait for worktree activity to finish.');
  if (message.includes('WORKTREE_DIRTY')) return t('Commit or move the worktree files before removing it.');
  if (message.includes('WORKTREE_TARGET_DIRTY')) return t('Finish or set aside changes in the destination before merging.');
  if (message.includes('WORKTREE_TARGET_CHANGED')) return t('The destination branch or commit changed. Review it before merging.');
  if (message.includes('WORKTREE_MERGE_FAILED')) return t('Merge failed. The destination is clean and the candidate branch was kept.');
  if (/WORKTREE_MERGE_RECOVERY|WORKTREE_RECOVERY_REQUIRED/.test(message)) return t('Inspect the Git state before acknowledging recovery.');
  if (message.includes('WORKTREE_PREVIEW_STALE')) return t('The worktree inventory changed. Preview cleanup again.');
  if (message.includes('WORKTREE_SETUP_UNTRUSTED')) return t('Review the current setup hook in this worktree.');
  if (message.includes('WORKTREE_SETUP_ALREADY_DISPATCHED')) return t('Setup has already been dispatched for this worktree.');
  if (message.includes('WORKTREE_ALREADY_MERGED')) return t('The candidate has already been merged.');
  return t('The worktree operation could not be completed.');
}

export function WorktreesPanel() {
  const [items, setItems] = useState<WorktreeInventoryItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorktreeCleanupPreview>();
  const [hooks, setHooks] = useState<{ id: string; entries: HookDefinition[] }>();
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string>();
  const [message, setMessage] = useState('');
  const refresh = async () => setItems(await api.worktreeInventory());
  useEffect(() => {
    void refresh().catch(error => setMessage(worktreeError(error)));
  }, []);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try { await run(); }
    catch (error) { setMessage(worktreeError(error)); }
    finally { setBusy(false); }
  }

  async function inspect(item: WorktreeInventoryItem) {
    setHooks({ id: item.id, entries: (await api.listHooks(item.path)).hooks.filter(hook => hook.worktreeSetup) });
  }

  return (
    <section className="card settings-fields">
      <div className="row-between">
        <h3>{t('Managed worktrees')}</h3>
        <button className="btn-ghost small" type="button" disabled={busy} onClick={() => void act(refresh)}>{t('Refresh')}</button>
      </div>
      <p className="muted small">{t('Cleanup removes only clean, inactive worktrees. Branches with unmerged commits are kept.')}</p>
      {items.map(item => (
        <div className="item" key={item.id} data-worktree-state={item.state}>
          <label className="row">
            <input type="checkbox" disabled={busy || item.state !== 'ready'} checked={selected.includes(item.id)}
              onChange={event => {
                setPreview(undefined);
                setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id));
              }} />
            <strong>{item.branch ?? item.path}</strong>
          </label>
          <p className="muted small">{t(states[item.state])} · <code>{item.path}</code></p>
          {item.setup && <p className="small">{t(setupStates[item.setup])}</p>}
          {item.setup === 'not-started' && (item.state === 'ready' || item.state === 'dirty') &&
            <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void act(() => inspect(item))}>{t('Inspect setup hooks')}</button>}
          {item.state === 'recovery' && <button type="button" className="btn-ghost small" disabled={busy}
            onClick={() => {
              if (window.confirm(t('Confirm that you inspected the checkout and any partial setup before acknowledging recovery.'))) {
                void act(async () => { await api.acknowledgeWorktreeRecovery(item.id); await refresh(); });
              }
            }}>{t('Acknowledge recovery')}</button>}
          {hooks?.id === item.id && item.setup === 'not-started' && (
            <div className="stack">
              {!hooks.entries.length && <p>{t('No setup hooks are configured for this worktree.')}</p>}
              {hooks.entries.map(hook => (
                <div key={hook.id} className="card">
                  <strong>{hook.explicitId ?? hook.id}</strong>
                  <p><code>{hook.source}</code></p><pre>{hook.command}</pre>
                  {hook.status === 'untrusted' && <button type="button" className="btn-ghost small" disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('Trust this setup command in the selected worktree?'))) void act(async () => {
                        await api.reviewHooks(item.path, [{ id: hook.id, digest: hook.digest, trust: true }]);
                        await inspect(item);
                      });
                    }}>{t('Trust setup command')}</button>}
                  {hook.status === 'trusted' && <button type="button" className="btn-primary small" disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('Run the reviewed setup command once in this worktree?'))) void act(async () => {
                        setRunning(item.id);
                        try {
                          const state = await api.runWorktreeSetup(item.id, hook.id, hook.digest);
                          setMessage(t(setupStates[state]));
                        } finally { setRunning(undefined); await refresh(); }
                      });
                    }}>{t('Run worktree setup')}</button>}
                </div>
              ))}
            </div>
          )}
          {(running === item.id || item.setup === 'running') && <button type="button" className="btn-ghost small"
            onClick={() => void api.abort(item.id).catch(error => setMessage(worktreeError(error)))}>{t('Cancel worktree setup')}</button>}
        </div>
      ))}
      <button type="button" className="btn-ghost" disabled={!selected.length || busy} onClick={() => void act(async () => {
        setPreview(await api.previewWorktreeCleanup(selected));
      })}>{t('Preview worktree cleanup')}</button>
      {preview && <div className="card" data-worktree-preview>
        <ul>{preview.items.map(item => <li key={item.id}><code>{item.path}</code> · {t(states[item.state])}</li>)}</ul>
        <button type="button" className="btn-danger" disabled={busy || preview.items.some(item => item.state !== 'ready')}
          onClick={() => void act(async () => {
            setPreview(undefined);
            const result = await api.cleanupWorktrees(preview.items.map(item => item.id), preview.revision);
            setMessage(t('Worktrees removed · {removed}. Retained · {blocked}.', { removed: result.removed.length, blocked: result.blocked.length }));
            setSelected([]);
            await refresh();
          })}>{t('Confirm worktree cleanup')}</button>
      </div>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
