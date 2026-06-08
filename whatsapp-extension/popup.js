'use strict';

class WASender {
  constructor() {
    this.queue       = [];
    this.index       = 0;
    this.running     = false;
    this.results     = [];
    this.activeTabId = null;

    this.el = id => document.getElementById(id);
    this.el('phones').addEventListener('input',  () => { this.updateCounter(); this.persist(); });
    this.el('message').addEventListener('input', () => this.persist());
    this.el('delay').addEventListener('change',  () => this.persist());
    this.el('startBtn').addEventListener('click', () => this.start());
    this.el('stopBtn').addEventListener('click',  () => this.stop());

    this.restore();
  }

  /* ── persistence ── */
  persist() {
    chrome.storage.local.set({
      wa_phones:  this.el('phones').value,
      wa_message: this.el('message').value,
      wa_delay:   this.el('delay').value,
    });
  }

  restore() {
    chrome.storage.local.get(['wa_phones', 'wa_message', 'wa_delay'], d => {
      if (d.wa_phones)  this.el('phones').value  = d.wa_phones;
      if (d.wa_message) this.el('message').value = d.wa_message;
      if (d.wa_delay)   this.el('delay').value   = d.wa_delay;
      this.updateCounter();
    });
  }

  /* ── helpers ── */
  updateCounter() {
    const n = this.parseContacts(this.el('phones').value).length;
    this.el('phoneCount').textContent = `${n} numéro${n !== 1 ? 's' : ''}`;
  }

  parseContacts(raw) {
    return raw.split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => {
        const [rawPhone, ...rest] = l.split(',');
        const phone = rawPhone.trim().replace(/[\s\-\+\(\)]/g, '');
        const name  = rest.join(',').trim();
        return { phone, name };
      })
      .filter(c => /^\d{8,15}$/.test(c.phone));
  }

  setStatus(type, text) {
    const el = this.el('status');
    el.textContent = text;
    el.className   = `status ${type}`;
  }

  addLog(text, cls = '') {
    const d    = document.createElement('div');
    d.className = `log-line ${cls}`;
    const t    = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    d.textContent = `[${t}] ${text}`;
    const log  = this.el('log');
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  updateProgress() {
    const pct = this.queue.length ? (this.index / this.queue.length) * 100 : 0;
    this.el('progressBar').style.width = `${pct}%`;
    this.el('progressText').textContent = `${this.index} / ${this.queue.length}`;
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── main flow ── */
  start() {
    const contacts = this.parseContacts(this.el('phones').value);
    const message  = this.el('message').value.trim();

    if (!contacts.length) return this.setStatus('error', '⚠️ Aucun numéro valide trouvé');
    if (!message)         return this.setStatus('error', '⚠️ Veuillez saisir un message');

    this.queue   = contacts;
    this.index   = 0;
    this.running = true;
    this.results = [];

    this.el('log').innerHTML = '';
    this.el('startBtn').disabled = true;
    this.el('stopBtn').disabled  = false;
    this.setStatus('sending', '🚀 Envoi en cours…');
    this.addLog(`📋 ${contacts.length} contacts dans la file`, 'info');

    this.sendLoop(message);
  }

  stop() {
    this.running = false;
    if (this.activeTabId) {
      chrome.tabs.remove(this.activeTabId).catch(() => {});
      this.activeTabId = null;
    }
    this.el('stopBtn').disabled  = true;
    this.el('startBtn').disabled = false;
    this.setStatus('stopped', '⏹ Envoi arrêté');
  }

  async sendLoop(message) {
    while (this.running && this.index < this.queue.length) {
      const contact = this.queue[this.index];
      const msg     = message.replace(/\{name\}/g, contact.name || '');

      this.addLog(`📤 [${this.index + 1}/${this.queue.length}] Envoi à +${contact.phone}…`);
      this.updateProgress();

      try {
        await this.sendOne(contact.phone, msg);
        this.results.push({ ok: true });
        this.addLog(`✅ Envoyé à +${contact.phone}`, 'ok');
      } catch (err) {
        this.results.push({ ok: false });
        this.addLog(`❌ Échec +${contact.phone}: ${err.message}`, 'fail');
      }

      this.index++;
      this.updateProgress();

      if (this.running && this.index < this.queue.length) {
        const base  = (parseInt(this.el('delay').value) || 8) * 1000;
        const delay = base + Math.random() * 5000; // +0–5 s aléatoire anti-spam
        this.addLog(`⏳ Prochaine dans ${Math.round(delay / 1000)} s…`, 'info');
        await this.sleep(delay);
      }
    }

    if (this.running) {
      const ok = this.results.filter(r => r.ok).length;
      this.setStatus('done', `✅ Terminé : ${ok} / ${this.queue.length} envoyés`);
      this.addLog(`🏁 Campagne terminée — ${ok} succès, ${this.queue.length - ok} échecs`, 'info');
    }

    this.running = false;
    this.el('startBtn').disabled = false;
    this.el('stopBtn').disabled  = true;
  }

  /* ── single send ── */
  sendOne(phone, message) {
    return new Promise((resolve, reject) => {
      const url  = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
      let settled = false;
      let tabId   = null;

      const settle = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onTabUpdate);
        if (tabId) chrome.tabs.remove(tabId).catch(() => {});
        this.activeTabId = null;
        ok ? resolve() : reject(new Error(reason || 'Échec'));
      };

      // Hard timeout of 35 s per contact
      const timer = setTimeout(
        () => settle(false, 'Timeout — numéro introuvable ou WhatsApp non connecté'),
        35_000
      );

      chrome.tabs.create({ url, active: false }, tab => {
        tabId            = tab.id;
        this.activeTabId = tabId;
        let processed    = false;

        const onTabUpdate = async (id, info) => {
          if (id !== tabId || info.status !== 'complete' || processed) return;
          processed = true;
          chrome.tabs.onUpdated.removeListener(onTabUpdate);

          // WhatsApp Web React app needs a few seconds to boot after DOM ready
          await this.sleep(4500);
          if (!this.running) { settle(false, 'Arrêté'); return; }

          // Poll for the send button (or error state) up to ~15 s
          for (let attempt = 0; attempt < 30 && !settled; attempt++) {
            await this.sleep(500);

            let result;
            try {
              const res = await chrome.scripting.executeScript({
                target: { tabId },
                func: WASender.injectedClickSend,
              });
              result = res?.[0]?.result;
            } catch {
              settle(false, 'Onglet fermé de manière inattendue');
              return;
            }

            if (result === 'clicked') {
              await this.sleep(2000); // wait for message to actually send
              settle(true);
              return;
            }
            if (result === 'not_found') {
              settle(false, 'Numéro non inscrit sur WhatsApp');
              return;
            }
            if (result === 'not_logged_in') {
              settle(false, 'WhatsApp non connecté — scannez le QR code d\'abord');
              return;
            }
            // result === null → keep polling
          }

          settle(false, 'Bouton "Envoyer" introuvable après 15 s');
        };

        chrome.tabs.onUpdated.addListener(onTabUpdate);
      });
    });
  }

  /* Executed inside the WhatsApp Web tab — no closure allowed */
  static injectedClickSend() {
    // Check if login is required
    if (document.querySelector('canvas[aria-label="Scan me!"]') ||
        document.querySelector('[data-testid="qrcode"]')) {
      return 'not_logged_in';
    }

    // Check if contact was not found (WhatsApp shows a popup)
    if (document.querySelector('._amjy') ||
        document.querySelector('[data-testid="popup-contents"]')) {
      return 'not_found';
    }

    // Try known send-button selectors (WhatsApp Web 2025-2026)
    const selectors = [
      '[data-testid="send"]',
      'button[aria-label="Send"]',
      'button[aria-label="Envoyer"]',
      '[data-icon="send"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const btn = el.tagName === 'BUTTON' ? el : (el.closest('button') || el);
      btn.click();
      return 'clicked';
    }

    return null; // still loading
  }
}

document.addEventListener('DOMContentLoaded', () => new WASender());
