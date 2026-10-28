export const matchInProgress = phase => phase === 'question' || phase === 'result';

// The game view works without optional fullscreen or screen-wake-lock APIs.
export function createFocusMode({ doc = document, nav = navigator, notify = () => {} } = {}) {
  const root = doc.documentElement;
  const toolbar = doc.querySelector('#focusToolbar');
  const fullscreenButton = doc.querySelector('#fullscreenButton');
  const awakeButton = doc.querySelector('#awakeButton');
  const requestFullscreen = root.requestFullscreen || root.webkitRequestFullscreen;
  const exitFullscreen = doc.exitFullscreen || doc.webkitExitFullscreen;
  const fullscreenElement = () => doc.fullscreenElement || doc.webkitFullscreenElement;
  const supportsFullscreen = !!requestFullscreen && (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true);
  let active = false;
  let keepAwake = true;
  let wakeLock = null;
  let wakePending = false;
  let ownsFullscreen = false;

  function updateButtons() {
    const fullscreen = !!fullscreenElement();
    fullscreenButton.hidden = !supportsFullscreen;
    fullscreenButton.textContent = fullscreen ? 'Ablakos nézet' : 'Teljes képernyő';
    fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
    awakeButton.hidden = !nav.wakeLock?.request;
    awakeButton.textContent = wakeLock && !wakeLock.released ? 'Kijelző ébren ✓' : keepAwake ? 'Kijelző ébren tartása' : 'Kijelző ébren: ki';
    awakeButton.setAttribute('aria-pressed', String(!!wakeLock && !wakeLock.released));
  }
  async function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    updateButtons();
    try { await lock?.release(); } catch { /* The browser may have released it already. */ }
  }
  async function requestWakeLock() {
    if (!active || !keepAwake || doc.hidden || wakePending || wakeLock && !wakeLock.released || !nav.wakeLock?.request) return;
    wakePending = true;
    try {
      const lock = await nav.wakeLock.request('screen');
      if (!active || !keepAwake || doc.hidden) { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) { wakeLock = null; updateButtons(); } });
    } catch { /* Low battery, permissions and older browsers must not interrupt play. */ }
    finally { wakePending = false; updateButtons(); }
  }
  async function leaveFullscreen() {
    if (!ownsFullscreen) return;
    ownsFullscreen = false;
    try { if (fullscreenElement() && exitFullscreen) await exitFullscreen.call(doc); } catch { /* Already left. */ }
  }
  fullscreenButton.addEventListener('click', async () => {
    if (!active || !supportsFullscreen) return;
    fullscreenButton.disabled = true;
    try {
      if (fullscreenElement()) { if (exitFullscreen) await exitFullscreen.call(doc); ownsFullscreen = false; }
      else {
        // This call stays inside a tap/click handler, as required on mobile.
        await requestFullscreen.call(root);
        ownsFullscreen = true;
        if (!active) await leaveFullscreen();
      }
    } catch { notify('A teljes képernyő itt nem érhető el. A fókusznézetben tovább játszhatsz.'); }
    finally { fullscreenButton.disabled = false; updateButtons(); }
  });
  awakeButton.addEventListener('click', () => {
    if (!active) return;
    keepAwake = !wakeLock || wakeLock.released;
    if (keepAwake) void requestWakeLock();
    else void releaseWakeLock();
  });
  doc.addEventListener('fullscreenchange', updateButtons);
  doc.addEventListener('webkitfullscreenchange', updateButtons);
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) void releaseWakeLock();
    else void requestWakeLock();
  });
  doc.defaultView?.addEventListener('pagehide', () => setActive(false));

  function setActive(value) {
    value = !!value;
    if (active === value) return;
    active = value;
    doc.body.classList.toggle('match-focus', active);
    toolbar.hidden = !active;
    if (active) {
      for (const dialog of doc.querySelectorAll('dialog[open]')) dialog.close();
      void requestWakeLock();
    } else {
      void releaseWakeLock();
      void leaveFullscreen();
    }
    updateButtons();
  }
  updateButtons();
  return { setActive };
}
