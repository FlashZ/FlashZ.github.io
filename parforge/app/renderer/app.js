const $ = s => document.querySelector(s);
let state;
function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shortTime(iso) { try { return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); } catch { return ''; } }
function render(s) {
  state = s;
  $('#runState').textContent = s.processing ? 'Processing…' : (s.settings.autoRun ? 'Watching' : 'Paused');
  $('#parDot').className = `status-dot ${s.tools.par2 ? 'ok' : 'warn'}`;
  $('#parStatus').textContent = s.tools.par2 ? s.tools.par2Path : 'Not installed yet — downloaded from the official project when needed';
  $('#zipDot').className = `status-dot ${s.tools.sevenZip ? 'ok' : 'warn'}`;
  $('#zipStatus').textContent = s.tools.sevenZip ? s.tools.sevenZipPath : 'Not found — repair works, extraction waits for 7-Zip';
  $('#autoRun').checked = Boolean(s.settings.autoRun);
  $('#quietSeconds').value = s.settings.quietSeconds || 30;
  const watches = s.settings.watchFolders || [];
  $('#watchList').innerHTML = watches.length ? watches.map(f => `<div class="watch-item"><code>${esc(f)}</code><button data-remove="${encodeURIComponent(f)}">Remove</button></div>`).join('') : '<div class="empty">No folders watched yet. Add a download, NAS, or staging folder.</div>';
  document.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => window.parforge.removeWatchFolder(decodeURIComponent(b.dataset.remove)));
  const events = s.history || [];
  $('#history').innerHTML = events.length ? events.map(e => `<div class="event ${esc(e.level)}"><time>${esc(shortTime(e.time))}</time><span class="level">${esc(e.level)}</span><span title="${esc(e.folder)}">${esc(e.message)}</span></div>`).join('') : '<div class="empty">Nothing processed yet.</div>';
}
$('#addWatch').onclick = () => window.parforge.addWatchFolder();
$('#processNow').onclick = async () => { try { await window.parforge.processFolder(); } catch (e) { alert(e.message || e); } };
$('#choose7').onclick = () => window.parforge.choose7Zip();
$('#installPar').onclick = async () => { $('#installPar').disabled = true; try { await window.parforge.installPar2(); } catch (e) { alert(e.message || e); } finally { $('#installPar').disabled = false; } };
$('#autoRun').onchange = e => window.parforge.saveSettings({ autoRun: e.target.checked });
$('#quietSeconds').onchange = e => window.parforge.saveSettings({ quietSeconds: Number(e.target.value) });
$('#siteLink').onclick = e => { e.preventDefault(); window.parforge.openExternal('https://flashz.github.io/parforge/'); };
window.parforge.onState(render);
window.parforge.onLog(() => window.parforge.getState().then(render));
window.parforge.getState().then(render);
