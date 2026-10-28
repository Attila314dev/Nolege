import { esc } from './common.js';

export function aiStatusView(ai = {}) {
  if (!ai.configured) return { tone: 'neutral', title: 'AI nincs beállítva', detail: 'A mentett kérdésekből továbbra is játszhattok.' };
  if (ai.state === 'pending') return { tone: 'pending', title: ai.lastOperation === 'chat' ? 'A Kvízmester válaszol…' : ai.lastOperation === 'connection-test' ? 'API-kapcsolatteszt…' : 'AI-kérdések készülnek…', detail: 'Valódi API-hívás van folyamatban.' };
  if (ai.state === 'working' && ai.lastSuccessAt) return { tone: 'success', title: 'AI: legutóbbi hívás sikeres', detail: ai.lastProvider || 'Az AI használható választ adott.' };
  if (ai.state === 'error') return { tone: 'error', title: 'AI: legutóbbi hívás sikertelen', detail: ai.lastError?.message || 'Az AI most nem érhető el.' };
  return { tone: 'neutral', title: 'AI-kulcs beállítva · még nem teszteltük', detail: 'Az első modellhívás után látod a hívás eredményét.' };
}

export function renderAIStatus(element, ai = {}, pool = {}) {
  if (!element) return;
  const view = aiStatusView(ai);
  const time = ai.lastCompletedAt ? new Date(ai.lastCompletedAt).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const html = `<div class="ai-indicator ai-${view.tone}"><span class="ai-dot" aria-hidden="true"></span><strong>${esc(view.title)}</strong></div><p class="ai-detail">${esc(view.detail)}${time ? `<br>Utolsó hívás: ${esc(time)}` : ''}</p><div class="pool-status"><span>Készlet</span><strong>${Number(pool.available) || 0} / ${Number(pool.target) || 100}</strong><progress max="${Number(pool.target) || 100}" value="${Number(pool.available) || 0}" aria-label="Előkészített általános kérdések"></progress><span class="small muted">${pool.refilling ? 'Háttérfeltöltés folyamatban…' : 'Az általános kvíz várakozás nélkül indul.'}</span></div>${pool.lastError ? `<p class="small pool-warning">${esc(pool.lastError)}</p>` : ''}`;
  if (element.innerHTML !== html) element.innerHTML = html;
}
