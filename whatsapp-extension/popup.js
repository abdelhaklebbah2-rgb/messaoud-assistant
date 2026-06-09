'use strict';

/* ═══════════════════════════════════════════════════════
   Blob → base64 helper
   ═══════════════════════════════════════════════════════ */
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onloadend = () => res(r.result.split(',')[1]);
    r.onerror   = rej;
    r.readAsDataURL(blob);
  });
}

/* ═══════════════════════════════════════════════════════
   XLSX / CSV Parser  — no external library needed
   Supports: .xlsx (ZIP+XML) and .csv
   ═══════════════════════════════════════════════════════ */
class XLSXParser {

  static async parse(file) {
    if (file.name.toLowerCase().endsWith('.csv')) {
      return XLSXParser._parseCSV(await file.text());
    }
    return XLSXParser._parseXLSX(await file.arrayBuffer());
  }

  /* ── CSV ─────────────────────────────────── */
  static _parseCSV(text) {
    const rows = text.split(/\r?\n/).map(line => {
      const fields = [];
      let field = '', inQ = false;
      for (const ch of line) {
        if (ch === '"')              { inQ = !inQ; continue; }
        if (ch === ',' && !inQ)     { fields.push(field.trim()); field = ''; continue; }
        field += ch;
      }
      fields.push(field.trim());
      return fields;
    }).filter(r => r.some(f => f));

    return XLSXParser._rowsToContacts(
      rows.map(r => ({ A: r[0] || '', B: r[1] || '' }))
    );
  }

  /* ── XLSX ────────────────────────────────── */
  static async _parseXLSX(buffer) {
    const files = await XLSXParser._readZIP(buffer);
    const ss    = XLSXParser._parseSharedStrings(files['xl/sharedStrings.xml'] || '');
    const rows  = XLSXParser._parseSheet(files['xl/worksheets/sheet1.xml'] || '', ss);
    return XLSXParser._rowsToContacts(rows);
  }

  /* ── ZIP reader using the Central Directory ─ */
  static async _readZIP(buffer) {
    const view  = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const files = {};

    // Locate End-of-Central-Directory record (search backwards)
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('Fichier .xlsx corrompu ou invalide');

    const cdOffset  = view.getUint32(eocd + 16, true);
    const cdEntries = view.getUint16(eocd + 10, true);
    let pos = cdOffset;

    for (let i = 0; i < cdEntries; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;

      const compression = view.getUint16(pos + 10, true);
      const compSz      = view.getUint32(pos + 20, true);
      const fnLen       = view.getUint16(pos + 28, true);
      const extraLen    = view.getUint16(pos + 30, true);
      const commentLen  = view.getUint16(pos + 32, true);
      const localOff    = view.getUint32(pos + 42, true);
      const filename    = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fnLen));

      pos += 46 + fnLen + extraLen + commentLen;

      // Only extract XML files we need
      if (!filename.endsWith('.xml')) continue;

      // Local file header gives us the real data offset
      const lhFnLen    = view.getUint16(localOff + 26, true);
      const lhExtraLen = view.getUint16(localOff + 28, true);
      const dataStart  = localOff + 30 + lhFnLen + lhExtraLen;
      const raw        = bytes.slice(dataStart, dataStart + compSz);

      let decoded;
      if      (compression === 0) decoded = raw;
      else if (compression === 8) decoded = await XLSXParser._inflate(raw);
      else continue;

      files[filename] = new TextDecoder('utf-8').decode(decoded);
    }
    return files;
  }

  /* ── deflate-raw decompression (native browser stream) ── */
  static async _inflate(data) {
    const ds = new DecompressionStream('deflate-raw');
    const w  = ds.writable.getWriter();
    const r  = ds.readable.getReader();
    w.write(data); w.close();
    const chunks = [];
    for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  /* ── xl/sharedStrings.xml → string[] ─────── */
  static _parseSharedStrings(xml) {
    const strings = [];
    const siRe    = /<si>([\s\S]*?)<\/si>/g;
    const tRe     = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let si;
    while ((si = siRe.exec(xml)) !== null) {
      let text = '', t;
      while ((t = tRe.exec(si[1])) !== null) text += t[1];
      strings.push(XLSXParser._xml(text));
    }
    return strings;
  }

  /* ── xl/worksheets/sheet1.xml → [{A,B,...}] ─ */
  static _parseSheet(xml, ss) {
    const rows   = [];
    const rowRe  = /<row[^>]*>([\s\S]*?)<\/row>/g;
    const cellRe = /<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g;
    let rowM;
    while ((rowM = rowRe.exec(xml)) !== null) {
      const cells = {};
      let cm;
      while ((cm = cellRe.exec(rowM[1])) !== null) {
        const col  = cm[1];
        const type = (cm[2].match(/t="([^"]+)"/) || [])[1] || 'n';
        let val = '';
        if (type === 'inlineStr') {
          val = (cm[3].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '';
        } else {
          const v = (cm[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
          val = (type === 's') ? (ss[parseInt(v)] || '') : v;
        }
        cells[col] = XLSXParser._xml(val);
      }
      rows.push(cells);
    }
    return rows;
  }

  /* ── rows → [{phone, name}] ──────────────── */
  static _rowsToContacts(rows) {
    if (!rows.length) return [];
    const headerKeywords = ['phone','numero','numéro','tel','telephone','mobile','gsm'];
    const skip = headerKeywords.includes((rows[0].A || '').toLowerCase());
    return (skip ? rows.slice(1) : rows)
      .map(r => ({
        phone: (r.A || '').toString().replace(/[\s\-\+\(\)\.]/g, ''),
        name:  (r.B || '').toString().trim(),
      }))
      .filter(c => /^\d{8,15}$/.test(c.phone));
  }

  static _xml(s) {
    return (s || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#xD;/gi, '');
  }
}


/* ═══════════════════════════════════════════════════════
   Main Sender
   ═══════════════════════════════════════════════════════ */
class WASender {

  constructor() {
    this.queue       = [];
    this.index       = 0;
    this.running     = false;
    this.results     = [];
    this.activeTabId = null;
    this.imageData   = null; // { b64, mime } | null

    this._$  = id => document.getElementById(id);
    this._setupUI();
    this._restore();
    this._startClock();
  }

  /* ─── UI wiring ─── */
  _setupUI() {
    this._$('phones').addEventListener('input',   () => { this._updateCounter(); this._persist(); });
    this._$('message').addEventListener('input',  () => this._persist());
    this._$('delay').addEventListener('change',   () => this._persist());
    this._$('driveUrl').addEventListener('input', () => this._persist());

    this._$('excelFile').addEventListener('change', e => this._importExcel(e));
    this._$('clearContacts').addEventListener('click', () => this._clearContacts());
    this._$('previewBtn').addEventListener('click', () => this._loadDriveImage());
    this._$('clearPhoto').addEventListener('click', () => this._clearPhoto());

    this._$('startBtn').addEventListener('click', () => this.start());
    this._$('stopBtn').addEventListener('click',  () => this.stop());
  }

  /* ─── Persistence ─── */
  _persist() {
    chrome.storage.local.set({
      wa_phones:   this._$('phones').value,
      wa_message:  this._$('message').value,
      wa_delay:    this._$('delay').value,
      wa_driveUrl: this._$('driveUrl').value,
    });
  }

  _restore() {
    chrome.storage.local.get(['wa_phones','wa_message','wa_delay','wa_driveUrl'], d => {
      if (d.wa_phones)   this._$('phones').value   = d.wa_phones;
      if (d.wa_message)  this._$('message').value  = d.wa_message;
      if (d.wa_delay)    this._$('delay').value    = d.wa_delay;
      if (d.wa_driveUrl) this._$('driveUrl').value = d.wa_driveUrl;
      this._updateCounter();
    });
  }

  /* ─── Horloge + barre horaire ─── */
  _startClock() {
    const tick = () => {
      const now = new Date();
      const hh  = String(now.getHours()).padStart(2, '0');
      const mm  = String(now.getMinutes()).padStart(2, '0');
      this._$('clock').textContent = `${hh}:${mm}`;
      this._refreshTimeBar(now.getHours());
    };
    tick();
    setInterval(tick, 15_000);
  }

  _refreshTimeBar(h) {
    const bar = this._$('timeBar');
    const txt = this._$('timeText');
    if (h >= 9 && h < 17) {
      bar.className    = 'time-bar active';
      txt.textContent  = `✅ Envoi autorisé — plage active (9h – 17h)`;
    } else {
      bar.className    = 'time-bar blocked';
      const when       = h >= 17 ? 'demain à 9h00' : "aujourd'hui à 9h00";
      txt.textContent  = `🚫 Hors horaires — prochain envoi ${when}`;
    }
  }

  _isWorkingHours() {
    const h = new Date().getHours();
    return h >= 9 && h < 17;
  }

  /* ─── Contacts ─── */
  _parseContacts(raw) {
    return raw.split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => {
        const [rp, ...rest] = l.split(',');
        return { phone: rp.trim().replace(/[\s\-\+\(\)\.]/g, ''), name: rest.join(',').trim() };
      })
      .filter(c => /^\d{8,15}$/.test(c.phone));
  }

  _updateCounter() {
    const n = this._parseContacts(this._$('phones').value).length;
    this._$('phoneCount').textContent = `${n} numéro${n !== 1 ? 's' : ''}`;
  }

  /* ─── Import Excel / CSV ─── */
  async _importExcel(e) {
    const file = e.target.files[0];
    if (!file) return;
    this._setStatus('sending', `⏳ Lecture de "${file.name}"…`);
    try {
      const contacts = await XLSXParser.parse(file);
      if (!contacts.length) throw new Error('Aucun numéro valide trouvé');

      this._$('phones').value = contacts
        .map(c => c.name ? `${c.phone},${c.name}` : c.phone)
        .join('\n');
      this._updateCounter();
      this._persist();

      this._$('excelInfo').classList.remove('hidden');
      this._$('excelFileName').textContent = `📄 ${file.name} — ${contacts.length} contacts importés`;
      this._setStatus('done', `✅ ${contacts.length} contacts importés`);
    } catch (err) {
      this._setStatus('error', `❌ ${err.message}`);
    }
    e.target.value = '';
  }

  _clearContacts() {
    this._$('phones').value = '';
    this._$('excelInfo').classList.add('hidden');
    this._updateCounter();
    this._persist();
  }

  /* ─── Google Drive image ─── */
  _extractDriveId(url) {
    for (const p of [
      /\/file\/d\/([a-zA-Z0-9_-]+)/,
      /[?&]id=([a-zA-Z0-9_-]+)/,
      /\/d\/([a-zA-Z0-9_-]+)/,
    ]) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  async _loadDriveImage() {
    const url    = this._$('driveUrl').value.trim();
    if (!url) return;
    const fileId = this._extractDriveId(url);
    if (!fileId) { this._setStatus('error', '❌ URL Google Drive invalide'); return; }

    this._setStatus('sending', '⏳ Chargement de la photo depuis Drive…');
    try {
      // Thumbnail URL works for publicly shared images (no auth)
      const imgUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
      const resp   = await fetch(imgUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} — vérifiez que le fichier est partagé publiquement`);

      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Le fichier ne semble pas être une image');

      const b64  = await blobToBase64(blob);
      this.imageData = { b64, mime: blob.type };

      const objUrl = URL.createObjectURL(blob);
      this._$('previewImg').src = objUrl;
      this._$('previewWrap').classList.remove('hidden');
      this._setStatus('done', `✅ Photo chargée (${Math.round(blob.size / 1024)} Ko)`);
    } catch (err) {
      this._setStatus('error', `❌ ${err.message}`);
    }
  }

  _clearPhoto() {
    this.imageData = null;
    this._$('driveUrl').value = '';
    this._$('previewImg').src = '';
    this._$('previewWrap').classList.add('hidden');
    this._persist();
  }

  /* ─── Start / Stop ─── */
  start() {
    if (!this._isWorkingHours()) {
      this._setStatus('error', '🚫 Hors des heures autorisées (9h – 17h)');
      return;
    }
    const contacts = this._parseContacts(this._$('phones').value);
    const message  = this._$('message').value.trim();
    if (!contacts.length) { this._setStatus('error', '⚠️ Aucun numéro valide'); return; }
    if (!message)         { this._setStatus('error', '⚠️ Veuillez saisir un message'); return; }

    this.queue   = contacts;
    this.index   = 0;
    this.running = true;
    this.results = [];

    this._$('log').innerHTML   = '';
    this._$('startBtn').disabled = true;
    this._$('stopBtn').disabled  = false;
    this._setStatus('sending', '🚀 Envoi en cours…');
    this._log(`📋 ${contacts.length} contacts | Photo: ${this.imageData ? '✅ oui' : '❌ non'}`, 'info');
    this._sendLoop(message);
  }

  stop() {
    this.running = false;
    if (this.activeTabId) {
      chrome.tabs.remove(this.activeTabId).catch(() => {});
      this.activeTabId = null;
    }
    this._$('stopBtn').disabled  = true;
    this._$('startBtn').disabled = false;
    this._setStatus('stopped', '⏹ Envoi arrêté');
  }

  /* ─── Send loop ─── */
  async _sendLoop(message) {
    while (this.running && this.index < this.queue.length) {

      // Block outside working hours
      if (!this._isWorkingHours()) {
        this._setStatus('stopped', '🚫 Hors des heures autorisées — campagne suspendue');
        this._log('🚫 Sortie de la plage 9h-17h — relancez demain matin', 'fail');
        this.running = false;
        break;
      }

      const contact = this.queue[this.index];
      const msg     = message.replace(/\{name\}/g, contact.name || '');
      this._log(`📤 [${this.index + 1}/${this.queue.length}] → +${contact.phone}${contact.name ? ' (' + contact.name + ')' : ''}…`);
      this._updateProgress();

      try {
        if (this.imageData) {
          await this._sendWithImage(contact.phone, msg, this.imageData);
        } else {
          await this._sendText(contact.phone, msg);
        }
        this.results.push({ ok: true });
        this._log(`✅ Envoyé à +${contact.phone}`, 'ok');
      } catch (err) {
        this.results.push({ ok: false });
        this._log(`❌ +${contact.phone} — ${err.message}`, 'fail');
      }

      this.index++;
      this._updateProgress();

      if (this.running && this.index < this.queue.length) {
        const base  = (parseInt(this._$('delay').value) || 8) * 1000;
        const delay = base + Math.random() * 5000; // +0–5s aléatoire (anti-détection)
        this._log(`⏳ Prochain dans ${Math.round(delay / 1000)}s…`, 'info');
        await this._sleep(delay);
      }
    }

    if (this.running) {
      const ok = this.results.filter(r => r.ok).length;
      this._setStatus('done', `✅ Terminé : ${ok} / ${this.queue.length} envoyés`);
      this._log(`🏁 Campagne terminée — ${ok} succès, ${this.queue.length - ok} échec(s)`, 'info');
    }
    this.running = false;
    this._$('startBtn').disabled = false;
    this._$('stopBtn').disabled  = true;
  }

  /* ─── Envoi texte seul ─── */
  _sendText(phone, message) {
    return this._openTab(
      `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`,
      async tabId => {
        for (let i = 0; i < 30; i++) {
          await this._sleep(500);
          const res = await this._exec(tabId, WASender._injectClickSend);
          if (res === 'clicked')       { await this._sleep(2000); return; }
          if (res === 'not_found')     throw new Error('Numéro non inscrit sur WhatsApp');
          if (res === 'not_logged_in') throw new Error('WhatsApp non connecté — scannez le QR d\'abord');
        }
        throw new Error('Bouton "Envoyer" introuvable après 15s');
      }
    );
  }

  /* ─── Envoi image + légende ─── */
  async _sendWithImage(phone, caption, imgData) {
    return this._openTab(
      `https://web.whatsapp.com/send?phone=${phone}`,
      async tabId => {
        // 1. Clic sur le bouton "Joindre" (+)
        const a1 = await this._execMain(tabId, WASender._injectClickAttach);
        if (a1 === 'not_logged_in') throw new Error('WhatsApp non connecté');
        if (a1 === 'not_found')     throw new Error('Numéro non inscrit sur WhatsApp');
        if (a1 !== 'clicked')       throw new Error('Bouton pièce jointe introuvable');

        await this._sleep(700);

        // 2. Injecter l'image dans l'input file
        const a2 = await this._execMain(tabId, WASender._injectSetFile, [imgData.b64, imgData.mime]);
        if (a2 !== 'set') throw new Error('Impossible d\'attacher la photo — input file non trouvé');

        // 3. Attendre l'aperçu de la photo
        await this._sleep(3000);

        // 4. Taper la légende
        if (caption) {
          await this._execMain(tabId, WASender._injectSetCaption, [caption]);
          await this._sleep(500);
        }

        // 5. Cliquer "Envoyer" dans l'aperçu media
        for (let i = 0; i < 12; i++) {
          await this._sleep(500);
          const r = await this._execMain(tabId, WASender._injectClickSendMedia);
          if (r === 'sent') { await this._sleep(2000); return; }
        }
        throw new Error('Bouton "Envoyer" (media) introuvable');
      }
    );
  }

  /* ─── Ouvre un onglet, attend le chargement, exécute handler, ferme ─── */
  _openTab(url, handler) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let tabId   = null;

      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdate);
        if (tabId) chrome.tabs.remove(tabId).catch(() => {});
        this.activeTabId = null;
        ok ? resolve() : reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timer = setTimeout(
        () => finish(false, new Error('Timeout 35s — contact introuvable ou connexion perdue')),
        35_000
      );

      chrome.tabs.create({ url, active: false }, tab => {
        tabId = tab.id;
        this.activeTabId = tabId;
        let processed = false;

        const onUpdate = async (id, info) => {
          if (id !== tabId || info.status !== 'complete' || processed) return;
          processed = true;
          chrome.tabs.onUpdated.removeListener(onUpdate);

          await this._sleep(4500); // Attendre que React monte
          if (!this.running) { finish(false, new Error('Arrêté par l\'utilisateur')); return; }

          try   { await handler(tabId); finish(true); }
          catch (e) { finish(false, e); }
        };

        chrome.tabs.onUpdated.addListener(onUpdate);
      });
    });
  }

  /* ─── Helpers executeScript ─── */
  async _exec(tabId, func, args = []) {
    const res = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return res?.[0]?.result;
  }

  async _execMain(tabId, func, args = []) {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return res?.[0]?.result;
  }

  /* ═══ Fonctions injectées dans WhatsApp Web ═══ */

  /* Vérifie état + clique Envoyer (flux texte) */
  static _injectClickSend() {
    if (document.querySelector('canvas[aria-label="Scan me!"]') ||
        document.querySelector('[data-testid="qrcode"]'))
      return 'not_logged_in';

    if (document.querySelector('._amjy') ||
        document.querySelector('[data-testid="popup-contents"]'))
      return 'not_found';

    for (const sel of ['[data-testid="send"]', 'button[aria-label="Send"]',
                        'button[aria-label="Envoyer"]', 'span[data-icon="send"]']) {
      const el  = document.querySelector(sel);
      const btn = el && (el.tagName === 'BUTTON' ? el : (el.closest('button') || el.parentElement));
      if (btn) { btn.click(); return 'clicked'; }
    }
    return null;
  }

  /* Étape 1 : clic sur le bouton d'attachement */
  static _injectClickAttach() {
    if (document.querySelector('canvas[aria-label="Scan me!"]')) return 'not_logged_in';
    if (document.querySelector('._amjy') ||
        document.querySelector('[data-testid="popup-contents"]')) return 'not_found';

    for (const icon of ['attach-menu-plus', 'clip', 'attach']) {
      const el  = document.querySelector(`[data-icon="${icon}"]`);
      const btn = el && (el.closest('button') || el.parentElement);
      if (btn) { btn.click(); return 'clicked'; }
    }
    const el = document.querySelector('[data-testid*="attach"]');
    if (el) { el.click(); return 'clicked'; }
    return 'not_found';
  }

  /* Étape 2 : injecter le fichier image dans l'input */
  static _injectSetFile(b64, mime) {
    const binary = atob(b64);
    const arr    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    const file = new File([new Blob([arr], { type: mime })], 'photo.jpg', { type: mime });
    const dt   = new DataTransfer();
    dt.items.add(file);

    const inputs = document.querySelectorAll('input[type="file"]');
    for (const inp of inputs) {
      if (!inp.accept || inp.accept.includes('image')) {
        Object.defineProperty(inp, 'files', { get: () => dt.files, configurable: true });
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set';
      }
    }
    return 'no_input';
  }

  /* Étape 3 : saisir la légende dans l'aperçu média */
  static _injectSetCaption(text) {
    for (const sel of [
      '[data-testid="media-caption-input-container"] [contenteditable]',
      '[data-lexical-editor="true"]',
      'div[contenteditable][data-tab="6"]',
    ]) {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand('insertText', false, text); return 'set'; }
    }
    return 'not_found';
  }

  /* Étape 4 : clic sur Envoyer dans l'aperçu média */
  static _injectClickSendMedia() {
    for (const sel of [
      '[data-testid="send"]',
      'button[aria-label="Send"]',
      'button[aria-label="Envoyer"]',
      'div[role="button"][aria-label="Send"]',
    ]) {
      const el  = document.querySelector(sel);
      const btn = el && (el.tagName === 'BUTTON' ? el : (el.closest('button') || el));
      if (btn) { btn.click(); return 'sent'; }
    }
    return null;
  }

  /* ─── UI utilities ─── */
  _updateProgress() {
    const pct = this.queue.length ? (this.index / this.queue.length) * 100 : 0;
    this._$('progressBar').style.width  = `${pct}%`;
    this._$('progressText').textContent = `${this.index} / ${this.queue.length}`;
  }

  _log(text, cls = '') {
    const d  = document.createElement('div');
    d.className = `log-line ${cls}`;
    const t  = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    d.textContent = `[${t}] ${text}`;
    const log = this._$('log');
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  _setStatus(type, text) {
    const el = this._$('status');
    el.textContent = text;
    el.className   = `status ${type}`;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

document.addEventListener('DOMContentLoaded', () => new WASender());
