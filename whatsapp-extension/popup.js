'use strict';

/* ══════════════════════════════════════
   Blob → base64
══════════════════════════════════════ */
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onloadend = () => res(r.result.split(',')[1]);
    r.onerror   = rej;
    r.readAsDataURL(blob);
  });
}

/* ══════════════════════════════════════
   XLSX / CSV Parser  — sans librairie
══════════════════════════════════════ */
class XLSXParser {

  static async parse(file) {
    if (file.name.toLowerCase().endsWith('.csv'))
      return XLSXParser._parseCSV(await file.text());
    return XLSXParser._parseXLSX(await file.arrayBuffer());
  }

  static _parseCSV(text) {
    const rows = text.split(/\r?\n/).map(line => {
      const fields = []; let field = '', inQ = false;
      for (const ch of line) {
        if (ch === '"')          { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { fields.push(field.trim()); field = ''; continue; }
        field += ch;
      }
      fields.push(field.trim());
      return fields;
    }).filter(r => r.some(f => f));
    return XLSXParser._rowsToContacts(rows.map(r => ({ A: r[0]||'', B: r[1]||'' })));
  }

  static async _parseXLSX(buffer) {
    const files = await XLSXParser._readZIP(buffer);
    const ss    = XLSXParser._parseSharedStrings(files['xl/sharedStrings.xml'] || '');
    const rows  = XLSXParser._parseSheet(files['xl/worksheets/sheet1.xml'] || '', ss);
    return XLSXParser._rowsToContacts(rows);
  }

  static async _readZIP(buffer) {
    const view = new DataView(buffer), bytes = new Uint8Array(buffer), files = {};
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--)
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd === -1) throw new Error('Fichier .xlsx invalide');
    const cdOffset = view.getUint32(eocd+16, true), cdEntries = view.getUint16(eocd+10, true);
    let pos = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const compression = view.getUint16(pos+10, true);
      const compSz = view.getUint32(pos+20, true), fnLen = view.getUint16(pos+28, true);
      const extraLen = view.getUint16(pos+30, true), commentLen = view.getUint16(pos+32, true);
      const localOff = view.getUint32(pos+42, true);
      const filename = new TextDecoder().decode(bytes.slice(pos+46, pos+46+fnLen));
      pos += 46 + fnLen + extraLen + commentLen;
      if (!filename.endsWith('.xml')) continue;
      const lhFnLen = view.getUint16(localOff+26, true), lhExtraLen = view.getUint16(localOff+28, true);
      const dataStart = localOff + 30 + lhFnLen + lhExtraLen;
      const raw = bytes.slice(dataStart, dataStart + compSz);
      let decoded;
      if      (compression === 0) decoded = raw;
      else if (compression === 8) decoded = await XLSXParser._inflate(raw);
      else continue;
      files[filename] = new TextDecoder('utf-8').decode(decoded);
    }
    return files;
  }

  static async _inflate(data) {
    const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter(), r = ds.readable.getReader();
    w.write(data); w.close();
    const chunks = [];
    for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
    const out = new Uint8Array(chunks.reduce((s,c) => s+c.length, 0));
    let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  static _parseSharedStrings(xml) {
    const strings = [], siRe = /<si>([\s\S]*?)<\/si>/g, tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let si;
    while ((si = siRe.exec(xml)) !== null) {
      let text = '', t;
      while ((t = tRe.exec(si[1])) !== null) text += t[1];
      strings.push(XLSXParser._xml(text));
    }
    return strings;
  }

  static _parseSheet(xml, ss) {
    const rows = [], rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g, cellRe = /<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g;
    let rowM;
    while ((rowM = rowRe.exec(xml)) !== null) {
      const cells = {}; let cm;
      while ((cm = cellRe.exec(rowM[1])) !== null) {
        const type = (cm[2].match(/t="([^"]+)"/) || [])[1] || 'n';
        let val = '';
        if (type === 'inlineStr') {
          val = (cm[3].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '';
        } else {
          const v = (cm[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
          val = (type === 's') ? (ss[parseInt(v)] || '') : v;
        }
        cells[cm[1]] = XLSXParser._xml(val);
      }
      rows.push(cells);
    }
    return rows;
  }

  static _rowsToContacts(rows) {
    if (!rows.length) return [];
    const hkw = ['phone','numero','numéro','tel','telephone','mobile','gsm'];
    const skip = hkw.includes((rows[0].A || '').toLowerCase());
    return (skip ? rows.slice(1) : rows)
      .map(r => ({
        phone: (r.A||'').toString().replace(/[\s\-\+\(\)\.]/g, ''),
        name:  (r.B||'').toString().trim(),
      }))
      .filter(c => /^\d{8,15}$/.test(c.phone));
  }

  static _xml(s) {
    return (s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#xD;/gi,'');
  }
}

/* ══════════════════════════════════════
   UI Controller
   (le moteur d'envoi est dans background.js)
══════════════════════════════════════ */
class WASenderUI {

  constructor() {
    this.$ = id => document.getElementById(id);
    this.imageData  = null;
    this._lastLogLen = 0;
    this._setupUI();
    this._restore();
    this._startClock();
    this._pollStorage();
    this._initWACheck();
  }

  /* ── Câblage événements ── */
  _setupUI() {
    this.$('phones').addEventListener('input',   () => { this._updateCounter(); this._persist(); });
    this.$('message').addEventListener('input',  () => this._persist());
    this.$('delay').addEventListener('change',   () => this._persist());
    this.$('driveUrl').addEventListener('input', () => this._persist());
    this.$('excelFile').addEventListener('change', e => this._importExcel(e));
    this.$('clearContacts').addEventListener('click', () => this._clearContacts());
    /* onglets photo */
    this.$('tabLocal').addEventListener('click', () => this._switchPhotoTab('local'));
    this.$('tabDrive').addEventListener('click', () => this._switchPhotoTab('drive'));
    /* upload local */
    this.$('localPhoto').addEventListener('change', e => this._loadLocalPhoto(e));
    /* drive */
    this.$('previewBtn').addEventListener('click', () => this._loadDriveImage());
    this.$('clearPhoto').addEventListener('click', () => this._clearPhoto());
    this.$('startBtn').addEventListener('click', () => this._start());
    this.$('stopBtn').addEventListener('click',  () => this._stop());
    this.$('openWaBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://web.whatsapp.com', active: true });
      setTimeout(() => this._checkWAConnected(), 3000);
    });
  }

  /* ── Vérification WA au démarrage du popup ── */
  async _initWACheck() {
    await this._checkWAConnected();
    setInterval(() => this._checkWAConnected(), 5000);
  }

  /* ── Démarrer ── */
  async _start() {
    if (!this._isWorkingHours()) {
      this._setStatus('error', '🚫 Hors des heures autorisées (9h – 17h)'); return;
    }
    const contacts = this._parseContacts(this.$('phones').value);
    const message  = this.$('message').value.trim();
    if (!contacts.length) { this._setStatus('error', '⚠️ Aucun numéro valide'); return; }
    if (!message)         { this._setStatus('error', '⚠️ Message vide'); return; }

    this._setStatus('sending', '🚀 Démarrage…');
    /* Vérifier que WA est connecté avant de démarrer */
    const waOk = await this._checkWAConnected();
    if (!waOk) {
      this._setStatus('error', '⚠️ Connectez WhatsApp Web d\'abord (scannez le QR)');
      return;
    }

    this.$('startBtn').disabled = true;
    this.$('stopBtn').disabled  = false;

    await chrome.runtime.sendMessage({
      action:   'start',
      contacts,
      message,
      image:    this.imageData,
      delay:    parseInt(this.$('delay').value) || 8,
    });
  }

  /* ── Vérifie si WA Web est connecté (onglet existant) ── */
  async _checkWAConnected() {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!tabs.length) {
      this._setWAStatus('disconnected', '⚠️ WhatsApp Web non ouvert');
      return false;
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          if (document.querySelector('canvas[aria-label="Scan me!"]') ||
              document.querySelector('[data-testid="qrcode"]')) return 'qr';
          if (document.querySelector('[data-testid="default-user"]') ||
              document.querySelector('[data-testid="chat-list"]') ||
              document.querySelector('#pane-side') ||
              document.querySelector('[aria-label="Chat list"]')) return 'ok';
          return 'loading';
        }
      });
      const state = results?.[0]?.result;
      if (state === 'ok') {
        this._setWAStatus('connected', '✅ WhatsApp connecté');
        return true;
      } else if (state === 'qr') {
        this._setWAStatus('disconnected', '⚠️ Scannez le QR code dans WhatsApp Web');
        chrome.tabs.update(tabs[0].id, { active: true });
        return false;
      }
    } catch(e) { /* tab not accessible */ }
    this._setWAStatus('disconnected', '⚠️ WhatsApp Web non connecté');
    return false;
  }

  _setWAStatus(state, text) {
    const bar = this.$('waStatus');
    bar.className = `wa-status ${state}`;
    this.$('waStatusIcon').textContent = state === 'connected' ? '✅' : state === 'disconnected' ? '⚠️' : '⏳';
    this.$('waStatusText').textContent = text;
  }

  /* ── Arrêter ── */
  async _stop() {
    await chrome.runtime.sendMessage({ action: 'stop' });
    this.$('stopBtn').disabled  = true;
    this.$('startBtn').disabled = false;
  }

  /* ── Sync UI depuis le storage (toutes les 500ms) ── */
  _pollStorage() {
    setInterval(async () => {
      const s = await chrome.storage.local.get([
        'wa_running','wa_done','wa_queue','wa_index','wa_results','wa_log'
      ]);
      this._syncUI(s);
    }, 500);
  }

  _syncUI(s) {
    const running = !!s.wa_running;
    const q       = s.wa_queue   || [];
    const idx     = s.wa_index   || 0;
    const results = s.wa_results || [];
    const log     = s.wa_log     || [];

    /* Boutons */
    this.$('startBtn').disabled = running;
    this.$('stopBtn').disabled  = !running;

    /* Progression */
    const pct = q.length ? (idx / q.length) * 100 : 0;
    this.$('progressBar').style.width  = `${pct}%`;
    this.$('progressText').textContent = `${idx} / ${q.length}`;

    /* Statut */
    if (running) {
      this._setStatus('sending', '🚀 Envoi en cours… fonctionne même popup fermé ✅');
    } else if (s.wa_done) {
      const ok = results.filter(r => r.ok).length;
      this._setStatus('done', `✅ Terminé : ${ok} / ${q.length} envoyés`);
    }

    /* Log — re-render uniquement si nouvelles entrées */
    if (log.length !== this._lastLogLen) {
      this._lastLogLen = log.length;
      const logEl  = this.$('log');
      const visible = log.slice(-50);
      logEl.innerHTML = '';
      for (const e of visible) {
        const d = document.createElement('div');
        d.className   = `log-line ${e.cls}`;
        d.textContent = `[${e.t}] ${e.text}`;
        logEl.appendChild(d);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  /* ── Persistence ── */
  _persist() {
    chrome.storage.local.set({
      wa_phones:   this.$('phones').value,
      wa_message:  this.$('message').value,
      wa_delay:    this.$('delay').value,
      wa_driveUrl: this.$('driveUrl').value,
    });
  }

  _restore() {
    chrome.storage.local.get(['wa_phones','wa_message','wa_delay','wa_driveUrl'], d => {
      if (d.wa_phones)   this.$('phones').value   = d.wa_phones;
      if (d.wa_message)  this.$('message').value  = d.wa_message;
      if (d.wa_delay)    this.$('delay').value    = d.wa_delay;
      if (d.wa_driveUrl) this.$('driveUrl').value = d.wa_driveUrl;
      this._updateCounter();
    });
  }

  /* ── Horloge + barre horaire ── */
  _startClock() {
    const tick = () => {
      const now = new Date();
      this.$('clock').textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      this._refreshTimeBar(now.getHours());
    };
    tick();
    setInterval(tick, 15_000);
  }

  _refreshTimeBar(h) {
    const active = h >= 9 && h < 17;
    this.$('timeBar').className   = `time-bar ${active ? 'active' : 'blocked'}`;
    this.$('timeText').textContent = active
      ? '✅ Envoi autorisé — plage active (9h – 17h)'
      : `🚫 Hors horaires — prochain envoi ${h >= 17 ? 'demain à 9h00' : "aujourd'hui à 9h00"}`;
  }

  _isWorkingHours() { const h = new Date().getHours(); return h >= 9 && h < 17; }

  /* ── Contacts ── */
  _parseContacts(raw) {
    return raw.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => { const [rp,...rest] = l.split(','); return { phone: rp.trim().replace(/[\s\-\+\(\)\.]/g,''), name: rest.join(',').trim() }; })
      .filter(c => /^\d{8,15}$/.test(c.phone));
  }

  _updateCounter() {
    const n = this._parseContacts(this.$('phones').value).length;
    this.$('phoneCount').textContent = `${n} numéro${n !== 1 ? 's' : ''}`;
  }

  /* ── Import Excel / CSV ── */
  async _importExcel(e) {
    const file = e.target.files[0];
    if (!file) return;
    this._setStatus('sending', `⏳ Lecture de "${file.name}"…`);
    try {
      const contacts = await XLSXParser.parse(file);
      if (!contacts.length) throw new Error('Aucun numéro valide trouvé');
      this.$('phones').value = contacts.map(c => c.name ? `${c.phone},${c.name}` : c.phone).join('\n');
      this._updateCounter();
      this._persist();
      this.$('excelInfo').classList.remove('hidden');
      this.$('excelFileName').textContent = `📄 ${file.name} — ${contacts.length} contacts`;
      this._setStatus('done', `✅ ${contacts.length} contacts importés`);
    } catch (err) {
      this._setStatus('error', `❌ ${err.message}`);
    }
    e.target.value = '';
  }

  _clearContacts() {
    this.$('phones').value = '';
    this.$('excelInfo').classList.add('hidden');
    this._updateCounter();
    this._persist();
  }

  /* ── Onglets photo ── */
  _switchPhotoTab(tab) {
    const isLocal = tab === 'local';
    this.$('tabLocal').classList.toggle('active', isLocal);
    this.$('tabDrive').classList.toggle('active', !isLocal);
    this.$('panelLocal').classList.toggle('hidden', !isLocal);
    this.$('panelDrive').classList.toggle('hidden', isLocal);
  }

  /* ── Upload local ── */
  async _loadLocalPhoto(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { this._setStatus('error', '❌ Fichier non supporté'); return; }
    this._setStatus('sending', '⏳ Chargement…');
    try {
      const b64 = await blobToBase64(file);
      this.imageData = { b64, mime: file.type };
      this.$('previewImg').src = URL.createObjectURL(file);
      this.$('previewWrap').classList.remove('hidden');
      this._setStatus('done', `✅ Photo chargée (${Math.round(file.size/1024)} Ko)`);
    } catch (err) {
      this._setStatus('error', `❌ ${err.message}`);
    }
    e.target.value = '';
  }

  /* ── Google Drive ── */
  _extractDriveId(url) {
    const patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/,       /* .../file/d/ID/view */
      /[?&]id=([a-zA-Z0-9_-]{10,})/,            /* ...?id=ID */
      /\/d\/([a-zA-Z0-9_-]{10,})/,              /* /d/ID */
      /googleusercontent\.com\/d\/([a-zA-Z0-9_-]{10,})/, /* lh3 direct */
      /thumbnail\?id=([a-zA-Z0-9_-]{10,})/,     /* thumbnail URL */
    ];
    for (const p of patterns) {
      const m = url.match(p); if (m) return m[1];
    }
    return null;
  }

  async _loadDriveImage() {
    const url = this.$('driveUrl').value.trim();
    if (!url) return;
    const fileId = this._extractDriveId(url);
    if (!fileId) {
      this._setStatus('error', '❌ URL invalide — utilisez "📁 Depuis l\'appareil" à la place');
      return;
    }
    this._setStatus('sending', '⏳ Chargement photo depuis Drive…');
    try {
      const imgUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
      const resp   = await fetch(imgUrl);
      if (!resp.ok) throw new Error(`Erreur Drive (${resp.status}) — vérifiez le partage public`);
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Pas une image — utilisez l\'onglet "Depuis l\'appareil"');
      const b64 = await blobToBase64(blob);
      this.imageData = { b64, mime: blob.type };
      this.$('previewImg').src = URL.createObjectURL(blob);
      this.$('previewWrap').classList.remove('hidden');
      this._setStatus('done', `✅ Photo chargée (${Math.round(blob.size/1024)} Ko)`);
    } catch (err) {
      this._setStatus('error', `❌ ${err.message}`);
    }
  }

  _clearPhoto() {
    this.imageData = null;
    this.$('driveUrl').value = '';
    this.$('localPhoto').value = '';
    this.$('previewImg').src = '';
    this.$('previewWrap').classList.add('hidden');
    this._persist();
  }

  /* ── Utilitaires UI ── */
  _setStatus(type, text) {
    const el = this.$('status');
    el.textContent = text;
    el.className   = `status ${type}`;
  }
}

document.addEventListener('DOMContentLoaded', () => new WASenderUI());
