import type { ReviewOutcome, ReviewSeverity, ReviewStatus } from '@sun/core';
import { useEffect, useState } from 'react';
import { api } from './api';
import { t, tk } from './i18n';

export const severityLabels: Record<ReviewSeverity, string> = {
  info: tk('Informational'), low: tk('Low'), medium: tk('Medium'), high: tk('High'), critical: tk('Critical'),
};
export const reviewSeverities = Object.keys(severityLabels) as ReviewSeverity[];

const stateLabels: Record<ReviewOutcome['state'] | 'stale', string> = {
  passed: tk('No findings in the reviewed changes.'),
  findings: tk('Review findings'),
  incomplete: tk('Review incomplete'),
  failed: tk('The review could not be completed. Run Review again.'),
  stale: tk('The changes have been edited since this review. Run Review again.'),
};

const omissionLabels: Record<ReviewOutcome['omissions'][number]['reason'], string> = {
  binary: tk('Binary file'),
  ignored: tk('Excluded by workspace ignore rules'),
  'outside-workspace': tk('Outside the workspace'),
  'no-text-diff': tk('No text diff'),
  'over-budget': tk('Diff exceeds the review budget'),
};

export function ReviewCard({ sessionId, report, latest, changed, minimumSeverity }: {
  sessionId: string;
  report: ReviewOutcome;
  latest: boolean;
  changed: string;
  minimumSeverity: ReviewSeverity;
}) {
  const [status, setStatus] = useState<ReviewStatus>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!latest) return;
    let current = true;
    function inspect() {
      void api.reviewStatus(sessionId).then(value => { if (current) setStatus(value); }, () => undefined);
    }
    inspect();
    window.addEventListener('focus', inspect);
    return () => { current = false; window.removeEventListener('focus', inspect); };
  }, [sessionId, report.requestSeq, changed, latest, refresh]);

  const state = latest && status?.state === 'stale' && status.report?.requestSeq === report.requestSeq ? 'stale' : report.state;
  const threshold = reviewSeverities.indexOf(minimumSeverity);
  const findings = report.findings.filter(finding => reviewSeverities.indexOf(finding.severity) >= threshold);
  const hidden = report.findings.length - findings.length;
  return (
    <section className="msg assistant review" data-review-state={latest ? state : 'historical'}>
      <div className="row-between">
        <strong className="tool-label">{latest ? t('Review') : t('Earlier review')}</strong>
        {latest && <button type="button" className="btn-ghost small" onClick={() => setRefresh(n => n + 1)}>{t('Check review status')}</button>}
      </div>
      <p role="status">{t(stateLabels[state])}</p>
      {findings.map(finding => (
        <div className="item" key={finding.id}>
          <strong>{finding.title}</strong> <span className="scope">{t(severityLabels[finding.severity])}</span>
          <p><code>{finding.path}:{finding.startLine}{finding.endLine !== finding.startLine && `–${finding.endLine}`}</code></p>
          <p>{finding.explanation}</p>
          <pre>{finding.evidence}</pre>
        </div>
      ))}
      {hidden > 0 && <p className="muted small">{hidden === 1 ? t('1 finding is below the display threshold.')
        : t('{n} findings are below the display threshold.', { n: hidden })}</p>}
      {report.omissions.length > 0 && <details>
        <summary>{t('Omitted changes ({n})', { n: report.omissions.length })}</summary>
        <ul>{report.omissions.map((item, i) => <li key={i}><code>{item.path}</code> · {t(omissionLabels[item.reason])}</li>)}</ul>
      </details>}
    </section>
  );
}
