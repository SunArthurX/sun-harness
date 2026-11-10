import { useEffect, useRef, useState } from 'react';
import type { ExecutionJob, ExecutionTarget, StartExecutionJob } from '@sun/core';
import { api } from '../api';
import { t, tk } from '../i18n';

const targetKinds = { local: tk('Current execution host'), container: tk('Local Docker'), 'remote-gateway': tk('Remote gateway') };
const targetHealth = { ready: tk('Ready'), offline: tk('Offline'), unsupported: tk('Unsupported'), 'identity-changed': tk('Target identity changed') };
const jobStates = {
  queued: tk('Queued'), running: tk('Running'), 'waiting-user': tk('Waiting for user'), paused: tk('Paused'),
  reconciling: tk('Reconciling'), succeeded: tk('Succeeded'), failed: tk('Failed'), cancelled: tk('Cancelled'),
};
const failures = {
  'session-unavailable': tk('The selected session is no longer available on this target.'),
  'environment-mismatch': tk('The selected session uses a different execution environment.'),
  'container-unavailable': tk('Local Docker or its configured image is unavailable.'),
};
const settled = (job: ExecutionJob) => ['succeeded', 'failed', 'cancelled'].includes(job.state);

export function ExecutionJobsPanel({ reportActivity }: { reportActivity(dirty: boolean, saving: boolean): void }) {
  const [targets, setTargets] = useState<ExecutionTarget[]>([]);
  const [jobs, setJobs] = useState<ExecutionJob[]>([]);
  const [targetId, setTargetId] = useState('');
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.executionTargetSessions>>>([]);
  const [sessionId, setSessionId] = useState('');
  const [command, setCommand] = useState('');
  const [review, setReview] = useState<StartExecutionJob>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<{ operationId: string; text: string }>();
  const refreshing = useRef(false);
  const active = useRef(true);
  const editing = useRef(false);
  const actionRevision = useRef(0);
  const nextRefresh = useRef(0);

  const replaceJob = (job: ExecutionJob) => setJobs(prior =>
    [job, ...prior.filter(item => item.operationId !== job.operationId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

  const refresh = async () => {
    if (refreshing.current || editing.current) return;
    refreshing.current = true;
    const revision = actionRevision.current;
    try {
      const [nextTargets, previousJobs] = await Promise.all([api.executionTargets(), api.listExecutionJobs()]);
      const pending = previousJobs.filter(job => !settled(job));
      const cursor = pending.length ? nextRefresh.current % pending.length : 0;
      const batch = [...pending.slice(cursor), ...pending.slice(0, cursor)].slice(0, 16);
      nextRefresh.current = cursor + batch.length;
      const updates = await Promise.allSettled(batch.map(job => api.refreshExecutionJob(job.operationId)));
      if (!active.current || revision !== actionRevision.current) return;
      const current = new Map(previousJobs.map(job => [job.operationId, job]));
      for (const update of updates) if (update.status === 'fulfilled') current.set(update.value.operationId, update.value);
      setTargets(nextTargets);
      setJobs([...current.values()]);
    } catch {
      if (active.current && !editing.current) setNotice(t('Execution target information could not be refreshed.'));
    } finally { refreshing.current = false; }
  };

  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let current = true;
    setSessions([]);
    setSessionId('');
    if (targetId) void api.executionTargetSessions(targetId).then(items => {
      if (current) setSessions(items);
    }, () => {
      if (current) setNotice(t('The target sessions could not be loaded.'));
    });
    return () => { current = false; };
  }, [targetId]);

  useEffect(() => reportActivity(!!command.trim(), busy), [command, busy, reportActivity]);
  useEffect(() => () => reportActivity(false, false), [reportActivity]);

  const perform = async (action: () => Promise<void>, error: string) => {
    if (editing.current) return;
    editing.current = true;
    actionRevision.current++;
    setBusy(true);
    setNotice('');
    try { await action(); }
    catch { if (active.current) setNotice(error); }
    finally {
      editing.current = false;
      if (active.current) setBusy(false);
    }
  };

  const start = () => {
    if (!review) return;
    void perform(async () => {
      const job = await api.startExecutionJob(review);
      replaceJob(job);
      setReview(undefined);
      setCommand('');
      if (job.state === 'reconciling') {
        setNotice(t('The launch is being checked by its original operation ID.'));
      }
    }, t('The launch could not be confirmed. Keep this review to retry the same operation.'));
  };

  return <>
    <p className="muted small">{t('Run a reviewed command in an existing session on a configured target. The selected session supplies the workspace and sandbox.')}</p>
    <section>
      <h3>{t('Available execution targets')}</h3>
      {targets.map(target => <div className="row" key={target.id}>
        <strong>{target.label}</strong>
        <span>{t(targetKinds[target.kind])}</span>
        <span className="muted small">{t(targetHealth[target.health])}</span>
      </div>)}
    </section>
    <section>
      <h3>{t('Launch a job')}</h3>
      <fieldset className="execution-job-fields" disabled={busy || !!review}>
        <label>{t('Execution target')}
          <select aria-label={t('Execution target')} value={targetId} onChange={event => setTargetId(event.target.value)}>
            <option value="">{t('Choose a target')}</option>
            {targets.map(target => <option key={target.id} value={target.id} disabled={target.health !== 'ready'}>
              {target.label} · {t(targetKinds[target.kind])}
            </option>)}
          </select>
        </label>
        <label>{t('Target session')}
          <select aria-label={t('Target session')} value={sessionId} onChange={event => setSessionId(event.target.value)} disabled={!targetId}>
            <option value="">{t('Choose a session')}</option>
            {sessions.map(session => <option key={session.id} value={session.id}>
              {session.title} · {t(targetKinds[session.environment === 'container' ? 'container' : 'local'])}
            </option>)}
          </select>
        </label>
        <label>{t('Shell command')}
          <textarea rows={3} maxLength={16 * 1024} value={command} onChange={event => setCommand(event.target.value)} />
        </label>
        <button type="button" disabled={!sessionId || !command.trim()} onClick={() =>
          setReview({ targetId, sessionId, command, operationId: crypto.randomUUID() })}>{t('Review job')}</button>
      </fieldset>
      {review && <div className="card">
        <h4>{t('Confirm execution')}</h4>
        <p>{targets.find(target => target.id === review.targetId)?.label} · {sessions.find(session => session.id === review.sessionId)?.title}</p>
        <pre>{review.command}</pre>
        <button type="button" className="btn-primary" disabled={busy} onClick={start}>{t('Start reviewed job')}</button>
        <button type="button" disabled={busy} onClick={() => setReview(undefined)}>{t('Cancel')}</button>
      </div>}
    </section>
    <section>
      <div className="row">
        <h3>{t('Execution jobs')}</h3>
        <button type="button" disabled={busy} onClick={() => { void refresh(); }}>{t('Refresh jobs')}</button>
      </div>
      {jobs.length === 0 && <p className="muted small">{t('No execution jobs yet.')}</p>}
      {jobs.map(job => <div key={job.operationId} className="card" data-execution-job={job.operationId}>
        <div className="row">
          <strong>{job.targetLabel}</strong>
          <span>{t(jobStates[job.state])}</span>
          {job.targetHealth && job.targetHealth !== 'ready' && <span>{t(targetHealth[job.targetHealth])}</span>}
          {job.cancellation && <span>{job.cancellation === 'requested' ? t('Cancellation requested') : t('Cancellation acknowledged')}</span>}
        </div>
        <code>{job.providerJobId ?? job.operationId}</code>
        {job.failure && <p>{t(failures[job.failure])}</p>}
        <div className="row">
          {!settled(job) && <button type="button" disabled={busy || job.cancellation === 'acknowledged'} onClick={() => {
            void perform(async () => replaceJob(await api.cancelExecutionJob(job.operationId)), t('Cancellation could not be confirmed.'));
          }}>{t('Cancel job')}</button>}
          {job.providerJobId && <button type="button" disabled={busy} onClick={() => {
            void perform(async () => setOutput({ operationId: job.operationId, text: await api.executionJobOutput(job.operationId) }),
              t('Output is unavailable from the originating target.'));
          }}>{t('View job output')}</button>}
        </div>
        {output?.operationId === job.operationId && <pre>{output.text || t('No job output yet.')}</pre>}
      </div>)}
    </section>
    {notice && <p role="status">{notice}</p>}
  </>;
}
