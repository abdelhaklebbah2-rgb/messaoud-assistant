package com.wasender

import android.annotation.SuppressLint
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.*
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import java.net.URLEncoder
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var etPhones: EditText
    private lateinit var etMessage: EditText
    private lateinit var etDelay: EditText
    private lateinit var btnStart: Button
    private lateinit var btnStop: Button
    private lateinit var progressBar: ProgressBar
    private lateinit var tvProgress: TextView
    private lateinit var tvLog: TextView
    private lateinit var tvStatus: TextView
    private lateinit var scrollLog: ScrollView

    private var sendingJob: Job? = null
    @Volatile private var isRunning = false
    @Volatile private var pageLoaded = false

    // ── UI ──────────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUI()
        setupWebView()
        webView.loadUrl("https://web.whatsapp.com")
    }

    private fun buildUI() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0D1117.toInt())
        }

        // WebView — top 55% of screen
        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 2.2f
            )
        }
        root.addView(webView)

        // Teal divider
        root.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2))
            setBackgroundColor(0xFF21D4A5.toInt())
        })

        // Scrollable controls panel — bottom 45%
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1.8f
            )
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(12))
        }

        // Status line
        tvStatus = textView("Prêt · Scannez le QR si besoin", 0xFF21D4A5.toInt(), 12f)
        panel.addView(tvStatus)

        // Reload WA Web button
        val btnReload = Button(this).apply {
            text = "🔄 Recharger WhatsApp Web"
            setBackgroundColor(0xFF161B22.toInt())
            setTextColor(0xFF21D4A5.toInt())
            textSize = 11f
            layoutParams = rowParams().also { it.bottomMargin = dp(8) }
            setOnClickListener {
                pageLoaded = false
                webView.loadUrl("https://web.whatsapp.com")
            }
        }
        panel.addView(btnReload)

        // Contacts
        panel.addView(label("📋 Numéros (un par ligne)"))
        panel.addView(hint("Format : 213600123456  ou  213600123456,Prénom"))
        etPhones = multilineInput("213600123456\n213699887766,Ahmed", 4)
        panel.addView(etPhones)

        // Message
        panel.addView(label("✏️ Message"))
        panel.addView(hint("{name} = prénom du contact"))
        etMessage = multilineInput("Bonjour {name} ! Je suis fournisseur en linge de bain…", 3)
        panel.addView(etMessage)

        // Delay row
        val delayRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = rowParams().also { it.bottomMargin = dp(8) }
            gravity = Gravity.CENTER_VERTICAL
        }
        delayRow.addView(label("⏱ Délai (s) :").apply { layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).also { it.marginEnd = dp(8) } })
        etDelay = EditText(this).apply {
            setText("12")
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFF161B22.toInt())
            setPadding(dp(8), dp(4), dp(8), dp(4))
            textSize = 13f
            layoutParams = LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        delayRow.addView(etDelay)
        delayRow.addView(textView("  min 8s", 0xFF666666.toInt(), 11f))
        panel.addView(delayRow)

        // Progress
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = rowParams()
            max = 100
            progress = 0
        }
        panel.addView(progressBar)

        tvProgress = textView("0 / 0", 0xFF21D4A5.toInt(), 11f).apply {
            gravity = Gravity.END
            layoutParams = rowParams().also { it.bottomMargin = dp(6) }
        }
        panel.addView(tvProgress)

        // Start / Stop buttons
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = rowParams().also { it.bottomMargin = dp(8) }
        }
        btnStart = Button(this).apply {
            text = "▶ Démarrer"
            setBackgroundColor(0xFF21D4A5.toInt())
            setTextColor(0xFF000000.toInt())
            textSize = 13f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).also { it.marginEnd = dp(8) }
            setOnClickListener { startSending() }
        }
        btnStop = Button(this).apply {
            text = "⏹ Arrêter"
            setBackgroundColor(0xFFCC3333.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 13f
            isEnabled = false
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { stopSending() }
        }
        btnRow.addView(btnStart)
        btnRow.addView(btnStop)
        panel.addView(btnRow)

        // Log
        tvLog = TextView(this).apply {
            setTextColor(0xFF888888.toInt())
            textSize = 10f
            typeface = Typeface.MONOSPACE
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        scrollLog = ScrollView(this).apply {
            addView(tvLog)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(80))
            setBackgroundColor(0xFF0A0E14.toInt())
        }
        panel.addView(scrollLog)

        scroll.addView(panel)
        root.addView(scroll)
        setContentView(root)
    }

    // ── WebView ─────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Desktop Chrome UA so WhatsApp Web works
            userAgentString = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                pageLoaded = true
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = false
        }
        webView.webChromeClient = WebChromeClient()
    }

    // ── Sending loop ─────────────────────────────────────────────────────────

    private fun parseContacts(): List<Pair<String, String>> =
        etPhones.text.toString().trim().lines()
            .filter { it.isNotBlank() }
            .map { line ->
                val parts = line.trim().split(",", limit = 2)
                val phone = parts[0].trim().replace(Regex("[^0-9]"), "")
                val name  = if (parts.size > 1) parts[1].trim() else ""
                phone to name
            }
            .filter { it.first.length >= 7 }

    private fun startSending() {
        val contacts = parseContacts()
        if (contacts.isEmpty()) { toast("Aucun numéro valide"); return }
        val msg = etMessage.text.toString().trim()
        if (msg.isEmpty()) { toast("Message vide"); return }
        val delaySec = etDelay.text.toString().toLongOrNull()?.coerceAtLeast(8) ?: 12L

        isRunning = true
        btnStart.isEnabled = false
        btnStop.isEnabled = true
        progressBar.max = contacts.size
        progressBar.progress = 0
        tvProgress.text = "0 / ${contacts.size}"
        tvLog.text = ""
        setStatus("Démarrage — ${contacts.size} contacts")

        sendingJob = lifecycleScope.launch {
            log("▶ Envoi de ${contacts.size} messages (délai ${delaySec}s)")
            var sent = 0; var failed = 0

            contacts.forEachIndexed { i, (phone, name) ->
                if (!isRunning) return@forEachIndexed

                val text    = msg.replace("{name}", name.ifEmpty { "." })
                val encoded = URLEncoder.encode(text, "UTF-8")
                val url     = "https://web.whatsapp.com/send?phone=$phone&text=$encoded"

                setStatus("${i + 1}/${contacts.size} → $phone")
                pageLoaded = false
                webView.loadUrl(url)

                // Wait page load (max 20 s)
                var w = 0
                while (!pageLoaded && w < 200) { delay(100); w++ }
                delay(4500) // WhatsApp needs extra time to init chat

                when (val r = injectClickSend()) {
                    "sent"          -> { sent++;  log("✅ $phone${if (name.isNotEmpty()) " ($name)" else ""}") }
                    "not_logged_in" -> { log("⚠️ Pas connecté — scannez le QR"); delay(12_000) }
                    "not_found"     -> { failed++; log("❌ $phone — numéro introuvable") }
                    else            -> { failed++; log("⚠️ $phone — $r") }
                }

                progressBar.progress = i + 1
                tvProgress.text = "${i + 1} / ${contacts.size}"

                if (isRunning && i < contacts.size - 1) delay(delaySec * 1_000)
            }

            isRunning = false
            btnStart.isEnabled = true
            btnStop.isEnabled  = false
            setStatus("Terminé — $sent ✅  $failed ❌")
            log("─── Fin : $sent envoyés, $failed échecs ───")
        }
    }

    private fun stopSending() {
        isRunning = false
        sendingJob?.cancel()
        btnStart.isEnabled = true
        btnStop.isEnabled  = false
        setStatus("Arrêté par l'utilisateur")
        log("─── Arrêté ───")
    }

    // ── JS injection ──────────────────────────────────────────────────────────

    private suspend fun injectClickSend(): String = suspendCoroutine { cont ->
        val js = """
        (function() {
          try {
            // Not logged in — QR code visible
            if (document.querySelector('canvas') &&
                (document.body.innerText.includes('QR') || document.body.innerText.includes('code'))) {
              return 'not_logged_in';
            }
            // Phone not on WhatsApp
            const popup = document.querySelector('[data-testid="confirm-popup"]') ||
                          document.querySelector('[data-animate-modal-body]');
            if (popup) return 'not_found';
            if (document.body.innerText.includes('Phone number shared via url is invalid')) return 'not_found';

            // Find and click send button
            const sels = [
              '[data-testid="send"]',
              '[data-testid="compose-btn-send"]',
              'button[aria-label="Send"]',
              'button[aria-label="Envoyer"]',
              'span[data-testid="send"]',
              'span[data-icon="send"]',
              '[role="button"][aria-label="Send"]'
            ];
            for (const s of sels) {
              const btn = document.querySelector(s);
              if (btn) {
                btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true}));
                btn.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true,cancelable:true}));
                btn.click();
                return 'sent';
              }
            }
            return 'no_button';
          } catch(e) {
            return 'error:' + e.message;
          }
        })()
        """.trimIndent()

        webView.evaluateJavascript(js) { result ->
            cont.resume(result?.trim('"') ?: "js_null")
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun log(msg: String) = runOnUiThread {
        val cur = tvLog.text.toString()
        tvLog.text = if (cur.isEmpty()) msg else "$cur\n$msg"
        scrollLog.post { scrollLog.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun setStatus(msg: String) = runOnUiThread { tvStatus.text = msg }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

    private fun rowParams() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).also { it.bottomMargin = dp(4) }

    private fun textView(t: String, color: Int, size: Float) = TextView(this).apply {
        text = t; setTextColor(color); textSize = size
        layoutParams = rowParams()
    }

    private fun label(t: String) = textView(t, 0xFFCCCCCC.toInt(), 12f)

    private fun hint(t: String) = textView(t, 0xFF555555.toInt(), 10f).also {
        it.layoutParams = rowParams().also { p -> p.bottomMargin = dp(2) }
    }

    private fun multilineInput(ph: String, lines: Int) = EditText(this).apply {
        hint = ph
        minLines = lines; maxLines = lines + 1
        gravity = Gravity.TOP
        setTextColor(0xFFFFFFFF.toInt())
        setHintTextColor(0xFF444444.toInt())
        setBackgroundColor(0xFF161B22.toInt())
        setPadding(dp(8), dp(6), dp(8), dp(6))
        textSize = 12f
        layoutParams = rowParams().also { it.bottomMargin = dp(8) }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
