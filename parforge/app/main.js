const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

let win;
let timer;
let processing = false;
let scanRunning = false;
let settings;
let history = [];
const sessionSeen = new Set();

const DEFAULTS = {
  watchFolders: [],
  quietSeconds: 30,
  scanSeconds: 15,
  autoRun: true,
  sevenZipPath: '',
  processed: {}
};

function userFile(name) { return path.join(app.getPath('userData'), name); }
async function loadJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; } }
async function saveJson(file, value) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8'); }
async function loadState() {
  settings = { ...DEFAULTS, ...(await loadJson(userFile('settings.json'), {})) };
  history = await loadJson(userFile('history.json'), []);
  if (!Array.isArray(history)) history = [];
  history = history.slice(0, 100);
}
async function persist() { await saveJson(userFile('settings.json'), settings); await saveJson(userFile('history.json'), history.slice(0, 100)); }
function emitState() { if (!win || win.isDestroyed()) return; win.webContents.send('state', stateSnapshot()); }
function log(message, level = 'info', folder = '') {
  const entry = { time: new Date().toISOString(), message, level, folder };
  history.unshift(entry); history = history.slice(0, 100);
  if (win && !win.isDestroyed()) win.webContents.send('log', entry);
  persist().catch(() => {});
}
function autoFind7Zip() {
  const candidates = [settings?.sevenZipPath, process.env.ProgramFiles && path.join(process.env.ProgramFiles, '7-Zip', '7z.exe'), process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe')].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || '';
}
function par2Path() { const p = path.join(app.getPath('userData'), 'tools', 'par2.exe'); return fs.existsSync(p) ? p : ''; }
function stateSnapshot() {
  return { settings: { ...settings, processed: undefined }, history: history.slice(0, 40), processing,
    tools: { par2: Boolean(par2Path()), par2Path: par2Path(), sevenZip: Boolean(autoFind7Zip()), sevenZipPath: autoFind7Zip() } };
}
async function download(url, dest, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
async function findFile(root, fileName) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) { const nested = await findFile(p, fileName); if (nested) return nested; }
    else if (entry.name.toLowerCase() === fileName.toLowerCase()) return p;
  }
  return '';
}
async function ensurePar2(force = false) {
  if (!force && par2Path()) return par2Path();
  const tools = path.join(app.getPath('userData'), 'tools');
  const staging = path.join(tools, '_par2_download');
  await fsp.rm(staging, { recursive: true, force: true }); await fsp.mkdir(staging, { recursive: true });
  log('Downloading the current official par2cmdline Windows build…');
  const release = await fetch('https://api.github.com/repos/Parchive/par2cmdline/releases/latest', { headers: { 'User-Agent': 'ParForge', 'Accept': 'application/vnd.github+json' } });
  if (!release.ok) throw new Error(`GitHub API returned ${release.status}`);
  const json = await release.json();
  const asset = (json.assets || []).find(a => /win-x64\.zip$/i.test(a.name));
  if (!asset) throw new Error('No Windows x64 par2cmdline asset found in latest release.');
  const zipPath = path.join(staging, asset.name);
  await download(asset.browser_download_url, zipPath, { 'User-Agent': 'ParForge' });
  new AdmZip(zipPath).extractAllTo(staging, true);
  const exe = await findFile(staging, 'par2.exe');
  if (!exe) throw new Error('Downloaded par2cmdline archive did not contain par2.exe.');
  const finalPath = path.join(tools, 'par2.exe'); await fsp.copyFile(exe, finalPath); await fsp.rm(staging, { recursive: true, force: true });
  log(`Installed par2cmdline ${json.tag_name || ''}.`); emitState(); return finalPath;
}
function runProcess(exe, args, cwd, prefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true }); let output = '';
    child.stdout.on('data', d => { output += d.toString(); }); child.stderr.on('data', d => { output += d.toString(); }); child.on('error', reject);
    child.on('close', code => { if (code === 0 || code === 1) resolve({ code, output }); else reject(new Error(`${prefix} exited with code ${code}. ${output.slice(-900)}`)); });
  });
}
function mainPar2(files) { const pars = files.filter(f => f.toLowerCase().endsWith('.par2')); return pars.find(f => !/\.vol\d+[+-]\d+\.par2$/i.test(f)) || pars[0] || ''; }
function firstRar(files) { return files.find(f => /\.part0*1\.rar$/i.test(f)) || files.find(f => /\.part1\.rar$/i.test(f)) || files.find(f => /\.rar$/i.test(f) && !/\.part\d+\.rar$/i.test(f)) || ''; }
async function fingerprint(dir, files) {
  const rows = [];
  for (const name of files.sort()) { if (!/\.(par2|rar|r\d\d|\d{3})$/i.test(name)) continue; try { const s = await fsp.stat(path.join(dir, name)); rows.push(`${name}:${s.size}:${Math.floor(s.mtimeMs)}`); } catch {} }
  return rows.join('|');
}
async function isQuiet(dir, files) {
  const threshold = Date.now() - Number(settings.quietSeconds || 30) * 1000;
  for (const name of files) { try { const s = await fsp.stat(path.join(dir, name)); if (s.mtimeMs > threshold) return false; } catch { return false; } }
  return true;
}
async function processFolder(dir, manual = false) {
  if (processing) throw new Error('ParForge is already processing another set.'); processing = true; emitState();
  try {
    const files = await fsp.readdir(dir); const par = mainPar2(files); const rar = firstRar(files);
    if (!par && !rar) throw new Error('No PAR2 or RAR set found in this folder.');
    if (!manual && !(await isQuiet(dir, files))) { log('Waiting for files to finish changing before processing.', 'info', dir); return; }
    const fp = await fingerprint(dir, files); if (!manual && settings.processed[dir] === fp) return;
    log(`Processing ${path.basename(dir) || dir}…`, 'info', dir);
    if (par) {
      const parExe = await ensurePar2(); log(`Verifying and repairing ${par}…`, 'info', dir);
      const result = await runProcess(parExe, ['r', par], dir, 'par2'); const tail = result.output.trim().split(/\r?\n/).slice(-2).join(' ');
      log(`PAR2 stage finished${tail ? ` — ${tail}` : ''}.`, 'success', dir);
    }
    const refreshed = await fsp.readdir(dir); const rarNow = firstRar(refreshed);
    if (rarNow) {
      const seven = autoFind7Zip();
      if (!seven) log('Repair finished, but 7-Zip was not found. Set its path in Settings to enable automatic RAR extraction.', 'warn', dir);
      else { log(`Extracting ${rarNow}…`, 'info', dir); await runProcess(seven, ['x', '-y', `-o${dir}`, rarNow], dir, '7-Zip'); log('RAR extraction finished.', 'success', dir); }
    }
    settings.processed[dir] = await fingerprint(dir, await fsp.readdir(dir)); await persist(); log('Set completed. Source files were kept.', 'success', dir);
  } catch (err) { log(err.message || String(err), 'error', dir); if (manual) throw err; }
  finally { processing = false; emitState(); }
}
async function walk(root, depth = 0, out = []) {
  if (depth > 4 || out.length > 4000) return out; let entries; try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  const fileNames = entries.filter(e => e.isFile()).map(e => e.name); if (fileNames.some(f => /\.par2$/i.test(f) || /\.rar$/i.test(f))) out.push({ dir: root, files: fileNames });
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(root, e.name), depth + 1, out); return out;
}
async function scan() {
  if (scanRunning || processing || !settings.autoRun) return; scanRunning = true;
  try { for (const root of settings.watchFolders) { const sets = await walk(root); for (const set of sets) { const key = set.dir; if (sessionSeen.has(key)) continue; const fp = await fingerprint(set.dir, set.files); if (settings.processed[set.dir] === fp) continue; if (!(await isQuiet(set.dir, set.files))) continue; sessionSeen.add(key); await processFolder(set.dir, false); sessionSeen.delete(key); if (processing) break; } } }
  finally { scanRunning = false; }
}
function restartTimer() { if (timer) clearInterval(timer); timer = setInterval(() => scan().catch(err => log(err.message, 'error')), Math.max(5, Number(settings.scanSeconds || 15)) * 1000); }
async function createWindow() {
  win = new BrowserWindow({ width: 1100, height: 760, minWidth: 860, minHeight: 620, backgroundColor: '#0b1020', title: 'ParForge', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
ipcMain.handle('state:get', async () => stateSnapshot());
ipcMain.handle('watch:add', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); if (!r.canceled && r.filePaths[0] && !settings.watchFolders.includes(r.filePaths[0])) { settings.watchFolders.push(r.filePaths[0]); await persist(); emitState(); scan().catch(() => {}); } return stateSnapshot(); });
ipcMain.handle('watch:remove', async (_e, folder) => { settings.watchFolders = settings.watchFolders.filter(f => f !== folder); delete settings.processed[folder]; await persist(); emitState(); return stateSnapshot(); });
ipcMain.handle('process:choose', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); if (!r.canceled && r.filePaths[0]) await processFolder(r.filePaths[0], true); return stateSnapshot(); });
ipcMain.handle('settings:save', async (_e, patch) => { settings = { ...settings, ...patch }; settings.quietSeconds = Math.min(600, Math.max(5, Number(settings.quietSeconds || 30))); settings.scanSeconds = Math.min(300, Math.max(5, Number(settings.scanSeconds || 15))); await persist(); restartTimer(); emitState(); return stateSnapshot(); });
ipcMain.handle('7zip:choose', async () => { const r = await dialog.showOpenDialog(win, { title: 'Choose 7z.exe', properties: ['openFile'], filters: [{ name: '7-Zip executable', extensions: ['exe'] }] }); if (!r.canceled && r.filePaths[0]) { settings.sevenZipPath = r.filePaths[0]; await persist(); emitState(); } return stateSnapshot(); });
ipcMain.handle('par2:install', async () => { await ensurePar2(true); return stateSnapshot(); });
ipcMain.handle('external:open', async (_e, url) => { if (/^https:\/\//i.test(url)) await shell.openExternal(url); });
app.whenReady().then(async () => { await loadState(); await createWindow(); restartTimer(); scan().catch(err => log(err.message, 'error')); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
