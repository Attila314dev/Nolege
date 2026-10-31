const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
let installPrompt = null;
const dialog = document.createElement('dialog'); dialog.id = 'installDialog'; dialog.className = 'install-dialog';
dialog.innerHTML = '<div class="dialog-header"><div><span class="eyebrow">NOLEGE A TELEFONODON</span><h2>Egy érintésre a társaság.</h2></div><button type="button" class="icon-button" id="closeInstall" aria-label="Telepítési útmutató bezárása">×</button></div><p>A Nolege saját ikonnal, külön alkalmazásablakban is megnyitható.</p><div id="installInstructions" class="install-instructions"></div><button id="nativeInstall" type="button" class="button primary wide" hidden>Telepítem a Nolege-t ↗</button><p class="small muted">Az élő játékhoz internetkapcsolat szükséges.</p>';
document.body.append(dialog);
const help = dialog.querySelector('#installInstructions'), nativeButton = dialog.querySelector('#nativeInstall');
function refresh() {
  const installed = standalone();
  document.querySelectorAll('[data-install]').forEach(button => { button.hidden = installed; });
  nativeButton.hidden = !installPrompt || installed;
  help.innerHTML = installed ? '<p>A Nolege már alkalmazásként fut ezen az eszközön. ✓</p>' : ios
    ? '<ol><li>Nyisd meg az oldalt a <b>Safariban</b>.</li><li>Válaszd a <b>Megosztás</b> menüt.</li><li><b>Kezdőképernyőhöz adás</b>, majd ha látható: <b>Megnyitás webappként</b>.</li><li>Érintsd meg a <b>Hozzáadás</b> gombot.</li></ol>'
    : '<p>Androidon a <b>Chrome ⋮ menüjében</b> válaszd a <b>Telepítés</b> vagy a <b>Hozzáadás a kezdőképernyőhöz</b> lehetőséget.</p><p class="small muted">Ha egy másik alkalmazáson belül nyílt meg az oldal, előbb nyisd meg a külső böngészőben. Számítógépen a böngésző címsorában is megjelenhet a telepítés ikonja.</p>';
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; refresh(); });
window.addEventListener('appinstalled', () => { installPrompt = null; dialog.close(); refresh(); });
document.querySelectorAll('[data-install]').forEach(button => button.addEventListener('click', () => { refresh(); if (!dialog.open) dialog.showModal(); }));
dialog.querySelector('#closeInstall').addEventListener('click', () => dialog.close());
nativeButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt; installPrompt = null;
  try { await prompt.prompt(); const result = await prompt.userChoice; if (result.outcome === 'accepted') dialog.close(); }
  catch { /* The manual instructions remain available. */ }
  refresh();
});
refresh();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
