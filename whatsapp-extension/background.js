'use strict';

/* ── helpers ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj  => chrome.storage.local.set(obj),
};

let _sending   = false;
let _activeTab = null;

/* ══════════════════════════════════════
   Alarmes — cadence & keep-alive
══════════════════════════════════════ */
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'wa_next') doNextSend();
  /* wa_keepalive : juste pour maintenir le SW actif */
});

/* ══════════════════════════════════════
   Messages depuis le popup
══════════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if (msg.action === 'start') { await startCampaign(msg); reply({ ok: true }); }
    else if (msg.action === 'stop') { await stopCampaign('⏹ Arrêté par l\'utilisateur'); reply({ ok: true }); }
    else reply({ ok: true });
  })();
  return true;
});

/* ══════════════════════════════════════
   Démarrage / arrêt
══════════════════════════════════════ */
async function startCampaign(msg) {
  await store.set({
    wa_running: true,
    wa_done:    false,
    wa_queue:   msg.contacts,
    wa_index:   0,
    wa_message: msg.message,
    wa_image:   msg.image || null,
    wa_delay:   msg.delay || 8,
    wa_results: [],
    wa_log:     [],
  });
  chrome.alarms.create('wa_keepalive', { periodInMinutes: 1/3 }); /* toutes les 20s */
  await doNextSend();
}

async function stopCampaign(reason) {
  await store.set({ wa_running: false });
  chrome.alarms.clear('wa_keepalive');
  chrome.alarms.clear('wa_next');
  if (_activeTab) { chrome.tabs.remove(_activeTab).catch(() => {}); _activeTab = null; }
  await pushLog(reason, 'fail');
}

/* ══════════════════════════════════════
   Étape suivante de la boucle
══════════════════════════════════════ */
async function doNextSend() {
  if (_sending) return;
  _sending = true;
  try {
    const s = await store.get(['wa_running','wa_queue','wa_index','wa_message','wa_image','wa_delay','wa_results']);

    if (!s.wa_running) { _sending = false; return; }

    const h = new Date().getHours();
    if (h < 9 || h >= 17) {
      await stopCampaign('🚫 Hors des heures 9h-17h — relancez demain à 9h');
      _sending = false; return;
    }

    const { wa_queue: q, wa_index: idx } = s;

    if (idx >= (q || []).length) {
      const ok = (s.wa_results || []).filter(r => r.ok).length;
      await store.set({ wa_running: false, wa_done: true });
      chrome.alarms.clear('wa_keepalive');
      await pushLog(`🏁 Terminé : ${ok} / ${(q||[]).length} envoyés`, 'info');
      _sending = false; return;
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

    const results = [...(s.wa_results || []), { ok }];
    await store.set({ wa_results: results });

    const totalMs = (parseInt(s.wa_delay) || 8) * 1000 + Math.random() * 5000;
    await pushLog(`⏳ Prochain dans ${Math.round(totalMs/1000)}s…`, 'info');
    chrome.alarms.create('wa_next', { delayInMinutes: totalMs / 60000 });

  } catch (e) {
    await pushLog(`⚠️ Erreur interne : ${e.message}`, 'fail');
  }
  _sending = false;
}

/* ══════════════════════════════════════
   Log persistant
══════════════════════════════════════ */
async function pushLog(text, cls = '') {
  const { wa_log = [] } = await store.get('wa_log');
  const t = new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  wa_log.push({ t, text, cls });
  if (wa_log.length > 300) wa_log.splice(0, wa_log.length - 300);
  await store.set({ wa_log });
}

/* ══════════════════════════════════════
   Ouverture d'onglet + handler
══════════════════════════════════════ */
function openTab(url, handler) {
  return new Promise((resolve, reject) => {
    let settled = false, tabId = null;

    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      _activeTab = null;
      ok ? resolve() : reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => done(false, new Error('Timeout 35s')), 35_000);

    chrome.tabs.create({ url, active: false }, tab => {
      tabId = tab.id;
      _activeTab = tabId;
      let processed = false;

      const onUpdate = async (id, info) => {
        if (id !== tabId || info.status !== 'complete' || processed) return;
        processed = true;
        chrome.tabs.onUpdated.removeListener(onUpdate);
        await sleep(4500);
        const { wa_running } = await store.get('wa_running');
        if (!wa_running) { done(false, new Error('Arrêté')); return; }
        try { await handler(tabId); done(true); } catch(e) { done(false, e); }
      };
      chrome.tabs.onUpdated.addListener(onUpdate);
    });
  });
}

const runScript = (tabId, func, args = []) =>
  chrome.scripting.executeScript({ target: { tabId }, func, args }).then(r => r?.[0]?.result);

const runMain = (tabId, func, args = []) =>
  chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }).then(r => r?.[0]?.result);

/* ── Envoi texte ── */
async function sendText(phone, message) {
  return openTab(
    `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`,
    async tabId => {
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        const r = await runScript(tabId, _injectClickSend);
        if (r === 'clicked')       { await sleep(2000); return; }
        if (r === 'not_found')     throw new Error('Numéro non inscrit sur WhatsApp');
        if (r === 'not_logged_in') throw new Error('WhatsApp non connecté — scannez le QR');
      }
      throw new Error('Bouton Envoyer introuvable après 15s');
    }
  );
}

/* ── Envoi image + légende ── */
async function sendWithImage(phone, caption, img) {
  return openTab(
    `https://web.whatsapp.com/send?phone=${phone}`,
    async tabId => {
      const a1 = await runMain(tabId, _injectClickAttach);
      if (a1 === 'not_logged_in') throw new Error('WhatsApp non connecté');
      if (a1 === 'not_found')     throw new Error('Numéro non inscrit');
      if (a1 !== 'clicked')       throw new Error('Bouton pièce jointe introuvable');
      await sleep(700);
      const a2 = await runMain(tabId, _injectSetFile, [img.b64, img.mime]);
      if (a2 !== 'set') throw new Error('Input file non trouvé');
      await sleep(3000);
      if (caption) { await runMain(tabId, _injectSetCaption, [caption]); await sleep(500); }
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        if (await runMain(tabId, _injectSendMedia) === 'sent') { await sleep(2000); return; }
      }
      throw new Error('Bouton Envoyer media introuvable');
    }
  );
}

/* ══════════════════════════════════════
   Fonctions injectées dans WhatsApp Web
   (auto-contenues — pas de closure SW)
══════════════════════════════════════ */
function _injectClickSend() {
  if (document.querySelector('canvas[aria-label="Scan me!"]') ||
      document.querySelector('[data-testid="qrcode"]')) return 'not_logged_in';
  if (document.querySelector('._amjy') ||
      document.querySelector('[data-testid="popup-contents"]')) return 'not_found';
  for (const sel of ['[data-testid="send"]','button[aria-label="Send"]',
                      'button[aria-label="Envoyer"]','span[data-icon="send"]']) {
    const el = document.querySelector(sel);
    const btn = el && (el.tagName === 'BUTTON' ? el : (el.closest('button') || el.parentElement));
    if (btn) { btn.click(); return 'clicked'; }
  }
  return null;
}

function _injectClickAttach() {
  if (document.querySelector('canvas[aria-label="Scan me!"]')) return 'not_logged_in';
  if (document.querySelector('._amjy') ||
      document.querySelector('[data-testid="popup-contents"]')) return 'not_found';
  for (const icon of ['attach-menu-plus','clip','attach']) {
    const el = document.querySelector(`[data-icon="${icon}"]`);
    const btn = el && (el.closest('button') || el.parentElement);
    if (btn) { btn.click(); return 'clicked'; }
  }
  const el = document.querySelector('[data-testid*="attach"]');
  if (el) { el.click(); return 'clicked'; }
  return 'not_found';
}

function _injectSetFile(b64, mime) {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([new Blob([arr], { type: mime })], 'photo.jpg', { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  for (const inp of document.querySelectorAll('input[type="file"]')) {
    if (!inp.accept || inp.accept.includes('image')) {
      Object.defineProperty(inp, 'files', { get: () => dt.files, configurable: true });
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'set';
    }
  }
  return 'no_input';
}

function _injectSetCaption(text) {
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

function _injectSendMedia() {
  for (const sel of ['[data-testid="send"]','button[aria-label="Send"]',
                      'button[aria-label="Envoyer"]','div[role="button"][aria-label="Send"]']) {
    const el = document.querySelector(sel);
    const btn = el && (el.tagName === 'BUTTON' ? el : (el.closest('button') || el));
    if (btn) { btn.click(); return 'sent'; }
  }
  return null;
}
