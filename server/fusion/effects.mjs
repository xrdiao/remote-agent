import { commitFusion, fusionEffect } from './state.mjs';

export async function runNativeEffect(run, { id, kind, data, canSettle = () => true }, perform, accept) {
  const existing = run.effects.find(row => row.id === id);
  if (existing?.status === 'done') return;
  // Only an explicitly classified native preflight rejection is retryable.
  // Transport failures and post-submit outcomes remain unknown and non-replayable.
  if (existing && existing.status !== 'preflightRejected') throw new Error('该原生操作的结果待核对');
  commitFusion(run, next => {
    const effect = fusionEffect(next, kind, data, id);
    Object.assign(effect, { status: 'executing', startedAt: Date.now() });
    if (existing) { effect.retryAfterPreflight = (effect.retryAfterPreflight || 0) + 1; delete effect.error; }
  });
  const settle = (status, error) => {
    if (!canSettle() || run.effects.find(row => row.id === id)?.status !== 'executing') return;
    commitFusion(run, next => {
      const effect = next.effects.find(row => row.id === id);
      if (status === 'done') accept?.(next);
      Object.assign(effect, { status, endedAt: Date.now(), ...(error ? { error: error.message } : {}) });
    });
  };
  try { await perform(); }
  catch (error) { settle('outcomeUnknown', error); throw error; }
  settle('done');
}

export function recordNativeTerminal(run, attempt, terminal) {
  Object.assign(attempt, { nativeTerminal: terminal, nativeGenerationEndedAt: terminal.endedAt });
  delete attempt.stopError;
  delete attempt.stopOutcomeUnknown;
  delete attempt.outcomeUnknown;
  const stop = run.effects.find(row => row.kind === 'native-stop' && row.data.attemptId === attempt.id
    && row.data.native?.threadId === attempt.native?.threadId && row.data.native?.turnId === attempt.native?.turnId);
  if (stop) {
    stop.observedEndedAt = terminal.endedAt;
    if (['executing', 'outcomeUnknown'].includes(stop.status)) stop.status = 'reconciled';
  }
}
