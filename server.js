const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const P = require("pino");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const WA_WEBHOOK_URL = process.env.WA_WEBHOOK_URL;

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

function extractRealPhone(msg) {
  const candidates = [
    msg?.key?.participantPn,
    msg?.participantPn,
    msg?.key?.senderPn,
    msg?.senderPn,
    msg?.key?.remoteJidAlt,
    msg?.remoteJidAlt,
    msg?.key?.participantAlt,
    msg?.participantAlt,
    msg?.key?.participant,
    msg?.key?.remoteJid,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    const sNetMatch = trimmed.match(/^(\d+)@s\.whatsapp\.net$/i);
    if (sNetMatch) return sNetMatch[1];

    if (!trimmed.includes("@")) {
      const digits = trimmed.replace(/\D/g, "");
      if (digits) return digits;
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
      body: JSON.stringify({
        event,
        tenant_id,
        data,
      }),
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
    try {
      await existing.sock.logout();
    } catch (_) {}

    try {
      existing.sock.ws?.close?.();
    } catch (_) {}
  }

  sessions.delete(tenantId);

  if (removeFiles) {
    removeSessionFiles(tenantId);
  }
}

async function startSession(tenantId, { forceFresh = false } = {}) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await getBaileys();

  const existing = sessions.get(tenantId);

  if (!forceFresh && existing) {
    if (existing.status === "connected") return existing;
    if (existing.status === "qr_pending") return existing;
    if (existing.status === "starting") return existing;
  }

  if (forceFresh) {
    await destroySession(tenantId, { removeFiles: true });
  }

  ensureSessionsDir();

  const sessionData = {
    sock: null,
    status: "starting",
    qrCode: null,
    phone: null,
    jid: null,
    startedAt: Date.now(),
  };

  sessions.set(tenantId, sessionData);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath(tenantId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Belleza Flow", "Chrome", "1.0"],
  });

  sessionData.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    const current = sessions.get(tenantId);
    if (!current || current.sock !== sock) return;

    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);

      current.status = "qr_pending";
      current.qrCode = qrImage;

      await sendWebhook("qr_update", {
        tenant_id: tenantId,
        qr: qrImage,
      });

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

      await sendWebhook("connected", {
        tenant_id: tenantId,
        phone_number: phone,
        jid,
      });

      console.log(`[${tenantId}] Connected — phone: ${phone || "unknown"}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      current.status = loggedOut ? "disconnected" : "reconnecting";
      current.qrCode = null;

      await sendWebhook("disconnected", {
        tenant_id: tenantId,
        reconnecting: !loggedOut,
      });

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

        try {
          await startSession(tenantId, { forceFresh: false });
        } catch (err) {
          console.error(`[${tenantId}] Reconnect failed:`, err.message);
        }
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
    const conversationJid = participantJid || remoteJid;

    if (!conversationJid || conversationJid.endsWith("@g.us")) return;

    const phone = extractRealPhone(msg);
    const body = extractMessageBody(msg);
    const rawTimestamp = Number(msg?.messageTimestamp || Math.floor(Date.now() / 1000));
    const ts = new Date(rawTimestamp * 1000).toISOString();
    const senderName = String(msg?.pushName || "").trim() || phone || conversationJid;

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
    });

    console.log(
      `[${tenantId}] Incoming from ${senderName} (${phone || "sin-phone"}) jid=${conversationJid}: ${String(body).slice(0, 60)}`,
    );
  } catch (err) {
    console.error(`[${tenantId}] handleIncoming error:`, err.message);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.post("/session/start", auth, async (req, res) => {
  try {
    const { tenant_id } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id required" });
    }

    const existing = sessions.get(tenant_id);
    const forceFresh = !existing || existing.status !== "connected";

    const session = await startSession(tenant_id, { forceFresh });

    return res.json({
      success: true,
      status: session?.status || "starting",
      qr_code: session?.qrCode || null,
      phone: session?.phone || null,
      jid: session?.jid || null,
    });
  } catch (err) {
    console.error("/session/start error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/session/status/:tenantId", auth, (req, res) => {
  const session = sessions.get(req.params.tenantId);

  return res.json({
    connected: session?.status === "connected",
    status: session?.status || "disconnected",
    qr_code: session?.qrCode || null,
    phone: session?.phone || null,
    jid: session?.jid || null,
  });
});

app.post("/session/disconnect", auth, async (req, res) => {
  try {
    const { tenant_id } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id required" });
    }

    await destroySession(tenant_id, { removeFiles: true });

    await sendWebhook("disconnected", {
      tenant_id,
      reconnecting: false,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("/session/disconnect error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/session/send", auth, async (req, res) => {
  try {
    const { tenant_id, phone, recipient_jid, message } = req.body;

    if (!tenant_id || !message) {
      return res.status(400).json({ error: "tenant_id and message required" });
    }

    const session = sessions.get(tenant_id);
    if (!session?.sock || session.status !== "connected") {
      return res.status(404).json({ error: "Session not found or not connected" });
    }

    let jid = normalizeJid(recipient_jid);

    if (!jid) {
      const cleanPhone = normalizePhone(phone);
      if (!cleanPhone) {
        return res.status(400).json({ error: "phone or recipient_jid required" });
      }
      jid = `${cleanPhone}@s.whatsapp.net`;
    }

    const result = await session.sock.sendMessage(jid, { text: String(message) });

    return res.json({
      success: true,
      jid,
      message_id: result?.key?.id || null,
    });
  } catch (err) {
    console.error(`[${req.body?.tenant_id || "unknown"}] Send error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function restoreActiveSessions() {
  ensureSessionsDir();

  const dirs = fs.readdirSync("./sessions").filter((d) => {
    try {
      return fs.statSync(`./sessions/${d}`).isDirectory();
    } catch (_) {
      return false;
    }
  });

  for (const tenantId of dirs) {
    console.log(`Restoring session: ${tenantId}`);
    startSession(tenantId, { forceFresh: false }).catch((err) =>
      console.error(`Failed to restore ${tenantId}:`, err.message),
    );
  }
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`WA Bridge listening on port ${PORT}`);
  await restoreActiveSessions();
});
