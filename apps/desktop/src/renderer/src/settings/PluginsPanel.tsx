import type { PluginAction, PluginState } from '@sun/core';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t, tk } from '../i18n';

const actionLabels: Record<PluginAction, string> = {
  tools: tk('Tools'), knowledge: tk('Knowledge providers'), modes: tk('Modes'), prompts: tk('Prompt sections'),
  'session-events': tk('Session events'), filesystem: tk('File system'), network: tk('Network'), processes: tk('Processes'),
};
const statuses: Record<PluginState['status'], string> = {
  loaded: tk('Active'), disabled: tk('Disabled'), draining: tk('Draining'), inactive: tk('Inactive'), error: tk('Error'),
};
const errors: Record<NonNullable<PluginState['error']>, string> = {
  INVALID_MANIFEST: tk('Invalid plugin manifest'), NO_ENTRY: tk('Plugin entry point is missing'),
  ACTIVATION_FAILED: tk('Plugin activation failed'),
};

export function PluginsPanel() {
  const [plugins, setPlugins] = useState<PluginState[]>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const liveUpdates = useRef(0);
  useEffect(() => {
    let current = true;
    let seenEvent = false;
    const unsubscribe = window.sun.onLive(event => {
      if (event.kind !== 'plugins') return;
      liveUpdates.current++;
      seenEvent = true;
      setPlugins(event.plugins);
    });
    void api.listPlugins().then(
      items => { if (current && !seenEvent) setPlugins(items); },
      () => { if (current && !seenEvent) setMessage(t('Could not inspect plugins.')); },
    );
    return () => { current = false; unsubscribe(); };
  }, []);

  async function change(plugin: PluginState) {
    setPending(true);
    setMessage('');
    try {
      const { revision } = await api.getSettings();
      const result = await api.setPluginEnabled({ name: plugin.name, enabled: !plugin.enabled, expectedRevision: revision });
      if (!result.ok) {
        setMessage(result.code === 'CONFLICT' ? t('Settings changed. Review the current plugin state and try again.')
          : result.code === 'BUSY' ? t('Wait for plugin work to finish, then try again.')
          : t('Could not change the plugin state.'));
      } else if (result.audit === 'incomplete' || result.durability === 'uncertain') {
        setMessage(t('The change applied, but its saved record could not be confirmed.'));
      }
      const seen = liveUpdates.current;
      const items = await api.listPlugins();
      if (seen === liveUpdates.current) setPlugins(items);
    } catch {
      setMessage(t('Could not change the plugin state.'));
    } finally {
      setPending(false);
    }
  }

  async function reload() {
    setPending(true);
    setMessage('');
    const seen = liveUpdates.current;
    try {
      const items = await api.reloadPlugins();
      if (seen === liveUpdates.current) setPlugins(items);
    }
    catch { setMessage(t('Could not reload plugins.')); }
    finally { setPending(false); }
  }

  return (
    <section className="card" aria-label={t('Plugin controls')}>
      <div className="card-head">
        <h3>{t('Installed plugins')}</h3>
        <button className="btn-ghost small" disabled={pending} onClick={() => void reload()}>{t('Reload')}</button>
      </div>
      <p className="muted small">{t('Requested actions come from the plugin author. Enabled plugins run with the execution host’s privileges.')}</p>
      {message && <p className="small" role="status">{message}</p>}
      {plugins?.length === 0 && <p className="muted small">{t('No plugins in ~/.sun/plugins. See docs/manual/extensions.md for the plugin API.')}</p>}
      {plugins?.map(plugin => (
        <div className="item" key={plugin.name} data-plugin={plugin.name}>
          <div className="card-head">
            <div><strong>{plugin.name}</strong> <span className="muted small">{t(statuses[plugin.status])}</span></div>
            {typeof plugin.enabled === 'boolean' && (
              <button className="btn-ghost small" disabled={pending || plugin.status === 'draining'}
                onClick={() => void change(plugin)}>{plugin.enabled ? t('Disable plugin') : t('Enable plugin')}</button>
            )}
          </div>
          <p className="muted small">
            {plugin.manifest === 'declared'
              ? t('Requested actions · {actions}', { actions: plugin.requestedActions.map(action => t(actionLabels[action])).join(', ') || t('None declared') })
              : plugin.manifest === 'invalid' ? t('Invalid plugin manifest') : t('The plugin author has not declared requested actions.')}
          </p>
          {plugin.error && plugin.error !== 'INVALID_MANIFEST' && <p className="small">{t(errors[plugin.error] ?? errors.ACTIVATION_FAILED)}</p>}
          {plugin.status === 'draining' && <p className="small" role="status">{t('Calls finishing · {count}', { count: plugin.inFlight })}</p>}
          {plugin.lifecycleAudit === 'incomplete' && <p className="small">{t('The plugin lifecycle record could not be saved.')}</p>}
          {Object.entries(plugin.contributes).map(([kind, names]) => names.length > 0 && (
            <p className="muted small" key={kind}>{t(actionLabels[kind as PluginAction])} <code>{names.join(', ')}</code></p>
          ))}
        </div>
      ))}
    </section>
  );
}
