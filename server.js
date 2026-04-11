// v4 - Added Multimedia Support (Base64 Extraction for Lovable)
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const WA_WEBHOOK_URL = process.env.WA_WEBHOOK_URL;
const BRIDGE_PUBLIC_URL =
  process.env.BRIDGE_PUBLIC_URL ||
  (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null) ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

const MEDIA_CACHE_ROOT = "./media-cache";
const MEDIA_CACHE_TTL_MS = 72 * 60 * 60 * 1000;
if (!BRIDGE_API_KEY) {
  console.error("BRIDGE_API_KEY env var is required");
  process.exit(1);
}

let baileysCache = null;

async function getBaileys() {
  if (!baileysCache) {
    const mod = await import("@whiskeysockets/baileys");
    baileysCache = {
      makeWASocket: mod.default,
      useMultiFileAuthState: mod.useMultiFileAuthState,
      DisconnectReason: mod.DisconnectReason,
      fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion,
      downloadMediaMessage: mod.downloadMediaMessage
    };
  }
  return baileysCache;
}

const sessions = new Map();

function ensureSessionsDir() {
  if (!fs.existsSync("./sessions")) {
    fs.mkdirSync("./sessions", { recursive: true });
  }
}

function ensureMediaCacheDir(tenantId) {
  if (!fs.existsSync(MEDIA_CACHE_ROOT)) {
    fs.mkdirSync(MEDIA_CACHE_ROOT, { recursive: true });
  }

  const tenantDir = path.join(MEDIA_CACHE_ROOT, tenantId);
  if (!fs.existsSync(tenantDir)) {
    fs.mkdirSync(tenantDir, { recursive: true });
  }

  return tenantDir;
}

function mediaExtensionFromMimeType(mimetype) {
  const normalized = String(mimetype || "").toLowerCase();

  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mp4")) return normalized.startsWith("audio/") ? "m4a" : "mp4";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("pdf")) return "pdf";

  return "bin";
}

function buildBridgeMediaUrl(tenantId, messageId, mimetype, buffer) {
  if (!BRIDGE_PUBLIC_URL || !messageId || !buffer?.length) return null;

  try {
    const tenantDir = ensureMediaCacheDir(tenantId);
    const extension = mediaExtensionFromMimeType(mimetype);
    const fileName = `${messageId}.${extension}`;
    const filePath = path.join(tenantDir, fileName);

    fs.writeFileSync(filePath, buffer);

    return `${BRIDGE_PUBLIC_URL}/media/${encodeURIComponent(tenantId)}/${encodeURIComponent(fileName)}`;
  } catch (err) {
    console.error(`[${tenantId}] Error guardando media-cache:`, err.message);
    return null;
  }
}
function sessionPath(tenantId) {
  return `./sessions/${tenantId}`;
}

function removeSessionFiles(tenantId) {
  const path = sessionPath(tenantId);
  if (fs.existsSync(path)) {
    fs.rmSync(path, { recursive: true, force: true });
  }
}

function normalizePhone(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sNetMatch = trimmed.match(/^(\d+)@s\.whatsapp\.net$/i);
  if (sNetMatch) return sNetMatch[1];
  if (trimmed.includes("@")) return null;
  const digits = trimmed.replace(/\D/g, "");
  return digits || null;
}

function normalizeJid(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function isIgnoredIncomingJid(value) {
  if (typeof value !== "string") return false;
  const jid = value.trim().toLowerCase();
  if (!jid) return false;

  if (jid === "status@broadcast") return true;
  if (jid.endsWith("@broadcast")) return true;
  if (jid.endsWith("@newsletter")) return true;
  if (jid.endsWith("@g.us")) return true;

  return false;
}

function extractMessageBody(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    msg?.message?.documentMessage?.caption ||
    msg?.message?.buttonsResponseMessage?.selectedDisplayText ||
    msg?.message?.listResponseMessage?.title ||
    "[media]"
  );
}

function extractRealPhone(msg, tenantId = null) {
  const explicitCandidates = [
    msg?.key?.participantPn,
    msg?.participantPn,
    msg?.key?.senderPn,
    msg?.senderPn,
    msg?.phone_number,
    msg?.phone,
    msg?.from,
  ];

  for (const candidate of explicitCandidates) {
    const normalized = normalizePhone(candidate);
    if (normalized) return normalized;
  }

  const jidCandidates = [
    msg?.key?.remoteJid,
    msg?.key?.participant,
    msg?.remoteJid,
    msg?.participant,
  ];

  for (const candidate of jidCandidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    const sNetMatch = trimmed.match(/^(\d+)@s\.whatsapp\.net$/i);
    if (sNetMatch) return sNetMatch[1];
  }

  if (tenantId) {
    const sess = sessions.get(tenantId);
    if (sess?.lidToPhone?.size > 0) {
      for (const jid of [msg?.key?.participant, msg?.key?.remoteJid]) {
        if (typeof jid !== "string" || !jid.endsWith("@lid")) continue;
        const resolved = sess.lidToPhone.get(jid);
        if (resolved) {
          const m = resolved.match(/^(\d+)@s\.whatsapp\.net$/i);
          if (m) return m[1];
        }
      }
    }
  }

  return null;
}

function auth(req, res, next) {
  if (req.headers["x-api-key"] !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function sendWebhook(event, payload = {}) {
  if (!WA_WEBHOOK_URL) return;
  try {
    const { tenant_id, ...data } = payload;
    if (!tenant_id) {
      console.error(`Webhook ${event} skipped: missing tenant_id`);
      return;
    }
    const response = await fetch(WA_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": BRIDGE_API_KEY,
      },
      body: JSON.stringify({ event, tenant_id, data }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`Webhook ${event} failed: ${response.status} ${text}`);
    }
  } catch (err) {
    console.error(`Webhook ${event} error:`, err.message);
  }
}

async function destroySession(tenantId, { removeFiles = false } = {}) {
  const existing = sessions.get(tenantId);
  if (existing?.sock) {
    try { await existing.sock.logout(); } catch (_) {}
    try { existing.sock.ws?.close?.(); } catch (_) {}
  }
  sessions.delete(tenantId);
  if (removeFiles) removeSessionFiles(tenantId);
}

async function startSession(tenantId, { forceFresh = false } = {}) {
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await getBaileys();
  const existing = sessions.get(tenantId);
  if (!forceFresh && existing) {
    if (existing.status === "connected") return existing;
    if (existing.status === "qr_pending") return existing;
    if (existing.status === "starting") return existing;
  }
  if (forceFresh) await destroySession(tenantId, { removeFiles: true });
  ensureSessionsDir();
  
  const sessionData = { sock: null, status: "starting", qrCode: null, phone: null, jid: null, startedAt: Date.now(), lidToPhone: new Map() };
  sessions.set(tenantId, sessionData);
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath(tenantId));
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({ version, auth: state, logger: P({ level: "silent" }), printQRInTerminal: false, browser: ["Belleza Flow", "Chrome", "1.0"] });
  sessionData.sock = sock;
  
  sock.ev.on("creds.update", saveCreds);
  
  const _syncContacts = (contacts) => {
    const sess = sessions.get(tenantId);
    if (!sess) return;
    sess.lidToPhone = sess.lidToPhone || new Map();
    for (const c of contacts || []) {
      if (c.id && c.lid) sess.lidToPhone.set(c.lid, c.id);
    }
  };
  
  sock.ev.on("contacts-set", ({ contacts }) => _syncContacts(contacts));
  sock.ev.on("contacts-upsert", (contacts) => _syncContacts(contacts));
  
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    const current = sessions.get(tenantId);
    if (!current || current.sock !== sock) return;
    
    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      current.status = "qr_pending";
      current.qrCode = qrImage;
      await sendWebhook("qr_update", { tenant_id: tenantId, qr: qrImage });
      console.log(`[${tenantId}] QR updated`);
    }
    
    if (connection === "open") {
      const rawSelfId = String(sock.user?.id || "").split(":")[0];
      const phone = normalizePhone(rawSelfId);
      const jid = normalizeJid(rawSelfId);
      current.status = "connected";
      current.qrCode = null;
      current.phone = phone;
      current.jid = jid;
      await sendWebhook("connected", { tenant_id: tenantId, phone_number: phone, jid });
      console.log(`[${tenantId}] Connected - phone: ${phone || "unknown"}`);
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      current.status = loggedOut ? "disconnected" : "reconnecting";
      current.qrCode = null;
      await sendWebhook("disconnected", { tenant_id: tenantId, reconnecting: !loggedOut });
      
      if (loggedOut) {
        await destroySession(tenantId, { removeFiles: true });
        console.log(`[${tenantId}] Logged out`);
        return;
      }
      
      console.log(`[${tenantId}] Reconnecting in 5s...`);
      setTimeout(async () => {
        const latest = sessions.get(tenantId);
        if (!latest || latest.sock !== sock) return;
        sessions.delete(tenantId);
        try { await startSession(tenantId, { forceFresh: false }); }
        catch (err) { console.error(`[${tenantId}] Reconnect failed:`, err.message); }
      }, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg?.key?.fromMe) continue;
      await handleIncoming(tenantId, msg);
    }
  });

  return sessionData;
}

async function handleIncoming(tenantId, msg) {
  try {
    const remoteJid = normalizeJid(msg?.key?.remoteJid);
    const participantJid = normalizeJid(msg?.key?.participant);

    if (
      isIgnoredIncomingJid(remoteJid) ||
      isIgnoredIncomingJid(participantJid)
    ) {
      console.log(`[${tenantId}] Ignored status/broadcast/newsletter message`);
      return;
    }

    const conversationJid =
      (typeof remoteJid === "string" && remoteJid.endsWith("@s.whatsapp.net") ? remoteJid : null) ||
      (typeof participantJid === "string" && participantJid.endsWith("@s.whatsapp.net") ? participantJid : null) ||
      participantJid ||
      remoteJid;

    if (!conversationJid) return;

    const phone = extractRealPhone(msg, tenantId);
    const body = extractMessageBody(msg);
    const rawTimestamp = Number(msg?.messageTimestamp || Math.floor(Date.now() / 1000));
    const ts = new Date(rawTimestamp * 1000).toISOString();
    const senderName = String(msg?.pushName || "").trim() || phone || conversationJid;

    // --- NUEVO COMPONENTE: EXTRACCIÓN DE FOTOS Y AUDIO (BASE64) ---
    let mediaBase64 = null;
    let mimetype = null;
    let messageType = "conversation";
    let bridgeMediaUrl = null;

    if (msg.message?.imageMessage) {
      messageType = "imageMessage";
      mimetype = msg.message.imageMessage.mimetype;
    } else if (msg.message?.audioMessage) {
      messageType = "audioMessage";
      mimetype = msg.message.audioMessage.mimetype;
    } else if (msg.message?.videoMessage) {
      messageType = "videoMessage";
      mimetype = msg.message.videoMessage.mimetype;
    } else if (msg.message?.documentMessage) {
      messageType = "documentMessage";
      mimetype = msg.message.documentMessage.mimetype;
    }

    if (mimetype && sessions.has(tenantId)) {
      try {
        const { downloadMediaMessage } = await getBaileys();
        const sock = sessions.get(tenantId).sock;
        const logger = P({ level: "silent" });
        
        // Descargamos la foto/voz desencriptada desde WhatsApp
        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
        
        // Convertir a base64 para enviarlo limpio a tu CRM
        if (buffer) {
          mediaBase64 = buffer.toString("base64");
          bridgeMediaUrl = buildBridgeMediaUrl(
            tenantId,
            msg?.key?.id || `media_${Date.now()}`,
            mimetype,
            buffer
          );
        }
      } catch (err) {
        console.error(`[${tenantId}] Error extrayendo multimedia:`, err.message);
      }
    }
    // --------------------------------------------------------------

    await sendWebhook("message", {
      tenant_id: tenantId,
      from: phone,
      phone,
      jid: conversationJid,
      remote_jid: remoteJid,
      participant_jid: participantJid,
      senderPn: msg?.senderPn || msg?.key?.senderPn || null,
      participantPn: msg?.participantPn || msg?.key?.participantPn || null,
      body,
      sender_name: senderName,
      created_at: ts,
      wa_message_id: msg?.key?.id || null,
      download_url: bridgeMediaUrl,
      media_url: bridgeMediaUrl,
      mimetype: mimetype || null,
      message: {
        base64: mediaBase64,
        mimetype: mimetype || null,
        messageType: messageType
      }
    });

    console.log(
      `[${tenantId}] Incoming from ${senderName} (${phone || "sin-phone"}) jid=${conversationJid}: ${String(body).slice(0, 60)}`
    );
  } catch (err) {
    console.error(`[${tenantId}] handleIncoming error:`, err.message);
  }
}

app.get("/health", (_req, res) => { res.json({ ok: true, sessions: sessions.size }); });
app.get("/media/:tenantId/:fileName", (req, res) => {
  try {
    const tenantId = String(req.params.tenantId || "").trim();
    const fileName = path.basename(String(req.params.fileName || "").trim());

    if (!tenantId || !fileName) {
      return res.status(400).json({ error: "Invalid media path" });
    }

    const filePath = path.join(MEDIA_CACHE_ROOT, tenantId, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Media not found" });
    }

    const stats = fs.statSync(filePath);
    if (Date.now() - stats.mtimeMs > MEDIA_CACHE_TTL_MS) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return res.status(410).json({ error: "Media expired" });
    }

    const ext = path.extname(fileName).toLowerCase();
    const mimeByExt = {
      ".ogg": "audio/ogg",
      ".opus": "audio/ogg",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
    };

    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type(mimeByExt[ext] || "application/octet-stream");
    return res.sendFile(path.resolve(filePath));
  } catch (err) {
    console.error("/media error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/session/start", auth, async (req, res) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id required" });
    const existing = sessions.get(tenant_id);
    const forceFresh = !existing || existing.status !== "connected";
    const session = await startSession(tenant_id, { forceFresh });
    return res.json({ success: true, status: session?.status || "starting", qr_code: session?.qrCode || null, phone: session?.phone || null, jid: session?.jid || null });
  } catch (err) {
    console.error("/session/start error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/session/status/:tenantId", auth, (req, res) => {
  const session = sessions.get(req.params.tenantId);
  return res.json({ connected: session?.status === "connected", status: session?.status || "disconnected", qr_code: session?.qrCode || null, phone: session?.phone || null, jid: session?.jid || null });
});

app.post("/session/disconnect", auth, async (req, res) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id required" });
    await destroySession(tenant_id, { removeFiles: true });
    await sendWebhook("disconnected", { tenant_id, reconnecting: false });
    return res.json({ success: true });
  } catch (err) {
    console.error("/session/disconnect error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/session/send", auth, async (req, res) => {
  try {
    const { tenant_id, phone, recipient_jid, message } = req.body;
    if (!tenant_id || !message) return res.status(400).json({ error: "tenant_id and message required" });
    
    const session = sessions.get(tenant_id);
    if (!session?.sock || session.status !== "connected") {
      return res.status(404).json({ error: "Session not found or not connected" });
    }

    let jid = null;
    const target = recipient_jid || phone;

    if (target) {
      const justNumbers = String(target).replace(/\D/g, "");
      if (justNumbers) {
        jid = `${justNumbers}@s.whatsapp.net`;
      }
    }

    if (!jid) return res.status(400).json({ error: "phone or recipient_jid required" });

    console.log(`[${tenant_id}] Sending out to mathematically cleaned jid=${jid}`);
    const result = await session.sock.sendMessage(jid, { text: String(message) });
    return res.json({ success: true, jid, message_id: result?.key?.id || null });
  } catch (err) {
    console.error(`[${req.body?.tenant_id || "unknown"}] Send error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function restoreActiveSessions() {
  ensureSessionsDir();
  const dirs = fs.readdirSync("./sessions").filter((d) => {
    try { return fs.statSync(`./sessions/${d}`).isDirectory(); } catch (_) { return false; }
  });
  if (dirs.length === 0) { console.log("No sessions to restore"); return; }
  for (const tenantId of dirs) {
    console.log(`Restoring session: ${tenantId}`);
    startSession(tenantId, { forceFresh: false }).catch((err) => console.error(`Failed to restore ${tenantId}:`, err.message));
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`WA Bridge listening on port ${PORT}`);
  await restoreActiveSessions();
});
