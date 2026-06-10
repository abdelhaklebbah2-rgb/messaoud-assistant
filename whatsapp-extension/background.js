'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj  => chrome.storage.local.set(obj),
};

let _loopActive = false;

/* ══════════════════════════════════════
   Reprise si le SW redémarre
══════════════════════════════════════ */
chrome.runtime.onStartup.addListener(resumeIfNeeded);
chrome.runtime.onInstalled.addListener(resumeIfNeeded);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'wa_resume') resumeIfNeeded(); });

async function resumeIfNeeded() {
  const { wa_running } = await store.get('wa_running');
  if (wa_running && !_loopActive) runLoop();
}

/* ══════════════════════════════════════
   Messages popup
══════════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if      (msg.action === 'start') { await startCampaign(msg); reply({ ok: true }); }
    else if (msg.action === 'stop')  { await stopCampaign('⏹ Arrêté par l\'utilisateur'); reply({ ok: true }); }
    else reply({ ok: true });
  })();
  return true;
});

/* ══════════════════════════════════════
   Démarrage / arrêt
══════════════════════════════════════ */
async function startCampaign(msg) {
  await store.set({
    wa_running: true, wa_done: false,
    wa_queue:   msg.contacts, wa_index: 0,
    wa_message: msg.message,  wa_image: msg.image || null,
    wa_delay:   msg.delay || 10,
    wa_results: [], wa_log: [],
  });
  chrome.alarms.create('wa_resume', { periodInMinutes: 1 });
  runLoop();
}

async function stopCampaign(reason) {
  await store.set({ wa_running: false });
  chrome.alarms.clear('wa_resume');
  await pushLog(reason, 'fail');
}

/* ══════════════════════════════════════
   Boucle principale
══════════════════════════════════════ */
async function runLoop() {
  if (_loopActive) return;
  _loopActive = true;
  try {
    for (;;) {
      const s = await store.get([
        'wa_running','wa_queue','wa_index','wa_message','wa_image','wa_delay','wa_results'
      ]);
      if (!s.wa_running) break;

      const h = new Date().getHours();
      if (h < 9 || h >= 17) {
        await stopCampaign('🚫 Hors des heures 9h-17h — relancez demain à 9h');
        break;
      }

      const q = s.wa_queue || [], idx = s.wa_index || 0;
      if (idx >= q.length) {
        const ok = (s.wa_results || []).filter(r => r.ok).length;
        await store.set({ wa_running: false, wa_done: true });
        chrome.alarms.clear('wa_resume');
        await pushLog(`🏁 Terminé : ${ok} / ${q.length} envoyés`, 'info');
        break;
      }

      const contact = q[idx];
      const text    = s.wa_message.replace(/\{name\}/g, contact.name || '');
      await pushLog(`📤 [${idx+1}/${q.length}] → +${contact.phone}${contact.name ? ' ('+contact.name+')' : ''}…`);
      await store.set({ wa_index: idx + 1 });

      let ok = false;
      try {
        if (s.wa_image) await sendWithImage(contact.phone, text, s.wa_image);
        else            await sendText(contact.phone, text);
        ok = true;
        await pushLog(`✅ Envoyé à +${contact.phone}`, 'ok');
      } catch (e) {
        await pushLog(`❌ +${contact.phone} — ${e.message}`, 'fail');
      }
      await store.set({ wa_results: [...(s.wa_results || []), { ok }] });

      if (idx + 1 >= q.length) continue;

      const totalMs = (parseInt(s.wa_delay) || 10) * 1000 + Math.random() * 5000;
      await pushLog(`⏳ Prochain dans ${Math.round(totalMs/1000)}s…`, 'info');
      const stopped = await waitAlive(totalMs);
      if (stopped) break;
    }
  } catch (e) {
    await pushLog(`⚠️ Erreur interne : ${e.message}`, 'fail');
  } finally {
    _loopActive = false;
  }
}

async function waitAlive(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { wa_running } = await store.get('wa_running');
    if (!wa_running) return true;
    await sleep(Math.min(2000, end - Date.now()));
  }
  return false;
}

/* ══════════════════════════════════════
   Log
══════════════════════════════════════ */
async function pushLog(text, cls = '') {
  const { wa_log = [] } = await store.get('wa_log');
  const t = new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  wa_log.push({ t, text, cls });
  if (wa_log.length > 300) wa_log.splice(0, wa_log.length - 300);
  await store.set({ wa_log });
}

/* ══════════════════════════════════════
   Trouver l'onglet WhatsApp Web existant
   → on réutilise l'onglet connecté au lieu
     de créer des onglets en arrière-plan
══════════════════════════════════════ */
async function getWATab() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) throw new Error('Ouvrez WhatsApp Web (web.whatsapp.com) d\'abord');
  return tabs[0].id;
}

function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error('Timeout chargement page'));
    }, timeout);
    const fn = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(fn);
      clearTimeout(timer);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

const runScript = (tabId, func, args = []) =>
  chrome.scripting.executeScript({ target: { tabId }, func, args }).then(r => r?.[0]?.result);
const runMain = (tabId, func, args = []) =>
  chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }).then(r => r?.[0]?.result);

/* ── Envoi texte : navigue l'onglet WA existant ── */
async function sendText(phone, message) {
  const tabId = await getWATab();
  const url   = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;

  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  await sleep(5000); /* React mount */

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const { wa_running } = await store.get('wa_running');
    if (!wa_running) throw new Error('Arrêté');
    const r = await runScript(tabId, _injectClickSend);
    if (r === 'clicked')       { await sleep(2000); return; }
    if (r === 'not_found')     throw new Error('Numéro non inscrit sur WhatsApp');
    if (r === 'not_logged_in') throw new Error('WhatsApp non connecté — scannez le QR code');
  }
  throw new Error('Bouton Envoyer introuvable après 20s');
}

/* ── Envoi image + texte ── */
async function sendWithImage(phone, caption, img) {
  const tabId = await getWATab();
  await chrome.tabs.update(tabId, { url: `https://web.whatsapp.com/send?phone=${phone}` });
  await waitForLoad(tabId);
  await sleep(5000);

  const { wa_running } = await store.get('wa_running');
  if (!wa_running) throw new Error('Arrêté');

  /* 1. Clic pièce jointe */
  let a1 = null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    a1 = await runMain(tabId, _injectClickAttach);
    if (a1) break;
  }
  if (a1 === 'not_logged_in') throw new Error('WhatsApp non connecté');
  if (a1 === 'not_found')     throw new Error('Numéro non inscrit');
  if (a1 !== 'clicked')       throw new Error('Bouton pièce jointe introuvable');

  await sleep(800);

  /* 2. Injecter l'image */
  const a2 = await runMain(tabId, _injectSetFile, [img.b64, img.mime]);
  if (a2 !== 'set') throw new Error('Impossible d\'attacher la photo');
  await sleep(4000);

  /* 3. Légende */
  if (caption) {
    await runMain(tabId, _injectSetCaption, [caption]);
    await sleep(600);
  }

  /* 4. Envoyer */
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (await runMain(tabId, _injectSendMedia) === 'sent') { await sleep(2000); return; }
  }
  throw new Error('Bouton Envoyer (media) introuvable');
}

/* ══════════════════════════════════════
   Fonctions injectées dans la page WA
   (auto-contenues, pas de closure SW)
══════════════════════════════════════ */
function _injectClickSend() {
  /* QR code = pas connecté */
  if (document.querySelector('[data-ref]') ||
      document.querySelector('canvas[aria-label="Scan me!"]') ||
      document.querySelector('[data-testid="qrcode"]')) return 'not_logged_in';
  /* Popup "pas sur WA" */
  if (document.querySelector('[data-testid="popup-contents"]') ||
      document.querySelector('._amjy')) return 'not_found';

  const selectors = [
    '[data-testid="send"]',
    'button[aria-label="Send"]',
    'button[aria-label="Envoyer"]',
    'span[data-icon="send"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const btn = el.tagName === 'BUTTON' ? el : (el.closest('button') || el.parentElement);
    if (!btn) continue;
    /* Événements complets pour React */
    ['mousedown','mouseup','click'].forEach(ev =>
      btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true }))
    );
    return 'clicked';
  }
  return null;
}

function _injectClickAttach() {
  if (document.querySelector('[data-ref]') ||
      document.querySelector('canvas[aria-label="Scan me!"]')) return 'not_logged_in';
  if (document.querySelector('[data-testid="popup-contents"]') ||
      document.querySelector('._amjy')) return 'not_found';
  for (const icon of ['attach-menu-plus','clip','attach','plus-rounded','attachment']) {
    const el = document.querySelector(`[data-icon="${icon}"]`);
    const btn = el && (el.closest('button') || el.parentElement);
    if (btn) { btn.click(); return 'clicked'; }
  }
  for (const sel of ['[data-testid*="attach"]','[title*="Attach"]','[aria-label*="Attach"]','[aria-label*="Joindre"]']) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return 'clicked'; }
  }
  return null;
}

function _injectSetFile(b64, mime) {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([new Blob([arr], { type: mime })], 'photo.jpg', { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  for (const inp of document.querySelectorAll('input[type="file"]')) {
    if (!inp.accept || inp.accept.includes('image') || inp.accept === '*') {
      Object.defineProperty(inp, 'files', { get: () => dt.files, configurable: true });
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
      return 'set';
    }
  }
  return 'no_input';
}

function _injectSetCaption(text) {
  const sels = [
    '[data-testid="media-caption-input-container"] [contenteditable]',
    'div[contenteditable][data-lexical-editor]',
    '[data-lexical-editor="true"]',
    'div[contenteditable][role="textbox"]',
    'div[contenteditable][data-tab="6"]',
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      return 'set';
    }
  }
  return 'not_found';
}

function _injectSendMedia() {
  const sels = [
    '[data-testid="send"]',
    'button[aria-label="Send"]',
    'button[aria-label="Envoyer"]',
    'div[role="button"][aria-label="Send"]',
    'div[role="button"][aria-label="Envoyer"]',
    'span[data-icon="send"]',
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const btn = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
      ? el : (el.closest('button') || el.closest('[role="button"]') || el.parentElement);
    if (!btn) continue;
    ['mousedown','mouseup','click'].forEach(ev =>
      btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true }))
    );
    return 'sent';
  }
  return null;
}
