const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const P = require("pino");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const WA_WEBHOOK_URL = process.env.WA_WEBHOOK_URL;

if (!BRIDGE_API_KEY) {
  console.error("BRIDGE_API_KEY env var is required");
  process.exit(1);
}

// ─── Baileys lazy loader (ESM) ─────────────────────────────────────────────
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

// ─── In-memory session store ────────────────────────────────────────────────
const sessions = new Map();

// ─── Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Webhook helper ─────────────────────────────────────────────────────────
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

// ─── Start / restore a WhatsApp session ────────────────────────────────────
async function startSession(tenantId) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await getBaileys();

  const existing = sessions.get(tenantId);
  if (existing && (existing.status === "connected" || existing.status === "starting")) {
    return existing;
  }

  const sessionData = { sock: null, status: "starting", qrCode: null, phone: null };
  sessions.set(tenantId, sessionData);

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${tenantId}`);
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
    const session = sessions.get(tenantId);

    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);

      if (session) {
        session.status = "qr_pending";
        session.qrCode = qrImage;
      }

      await sendWebhook("qr_update", {
        tenant_id: tenantId,
        qr: qrImage,
      });

      console.log(`[${tenantId}] QR updated`);
    }

    if (connection === "open") {
      const phone = (sock.user?.id || "").split(":")[0].replace(/\D/g, "");

      if (session) {
        session.status = "connected";
        session.qrCode = null;
        session.phone = phone;
      }

      await sendWebhook("connected", {
        tenant_id: tenantId,
        phone_number: phone,
      });

      console.log(`[${tenantId}] Connected — phone: ${phone}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      sessions.delete(tenantId);

      await sendWebhook("disconnected", {
        tenant_id: tenantId,
        reconnecting: !loggedOut,
      });

      if (!loggedOut) {
        console.log(`[${tenantId}] Reconnecting in 5s...`);
        setTimeout(() => {
          startSession(tenantId).catch((err) =>
            console.error(`[${tenantId}] Reconnect failed:`, err.message),
          );
        }, 5000);
      } else {
        console.log(`[${tenantId}] Logged out`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      await handleIncoming(tenantId, msg);
    }
  });

  return sessionData;
}

// ─── Handle incoming WA message ─────────────────────────────────────────────
async function handleIncoming(tenantId, msg) {
  const jid = msg.key.remoteJid || "";
  if (jid.endsWith("@g.us")) return;

  const phone = jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "[media]";

  const rawTimestamp = Number(msg.messageTimestamp || Math.floor(Date.now() / 1000));
  const ts = new Date(rawTimestamp * 1000).toISOString();

  await sendWebhook("message", {
    tenant_id: tenantId,
    from: phone,
    body,
    sender_name: phone,
    created_at: ts,
    wa_message_id: msg.key.id || null,
  });

  console.log(`[${tenantId}] Incoming from ${phone}: ${body.slice(0, 40)}`);
}

// ─── REST endpoints ─────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.post("/session/start", auth, async (req, res) => {
  try {
    const { tenant_id } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id required" });
    }

    const session = await startSession(tenant_id);

    res.json({
      success: true,
      status: session?.status || "starting",
      qr_code: session?.qrCode || null,
      phone: session?.phone || null,
    });
  } catch (err) {
    console.error("/session/start error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/status/:tenantId", auth, (req, res) => {
  const session = sessions.get(req.params.tenantId);

  res.json({
    connected: session?.status === "connected",
    status: session?.status || "disconnected",
    qr_code: session?.qrCode || null,
    phone: session?.phone || null,
  });
});

app.post("/session/disconnect", auth, async (req, res) => {
  try {
    const { tenant_id } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id required" });
    }

    const session = sessions.get(tenant_id);

    if (session?.sock) {
      try {
        await session.sock.logout();
      } catch (_) {}
    }

    sessions.delete(tenant_id);

    const path = `./sessions/${tenant_id}`;
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }

    await sendWebhook("disconnected", {
      tenant_id,
      reconnecting: false,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("/session/disconnect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/session/send", auth, async (req, res) => {
  try {
    const { tenant_id, phone, message } = req.body;

    if (!tenant_id || !phone || !message) {
      return res.status(400).json({ error: "tenant_id, phone, message required" });
    }

    const session = sessions.get(tenant_id);
    if (!session?.sock || session.status !== "connected") {
      return res.status(404).json({ error: "Session not found or not connected" });
    }

    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });

    res.json({ success: true });
  } catch (err) {
    console.error(`[${req.body?.tenant_id || "unknown"}] Send error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── On startup: restore sessions from filesystem ─────────────────────────
async function restoreActiveSessions() {
  if (!fs.existsSync("./sessions")) {
    fs.mkdirSync("./sessions", { recursive: true });
    return;
  }

  const dirs = fs.readdirSync("./sessions").filter((d) => {
    try {
      return fs.statSync(`./sessions/${d}`).isDirectory();
    } catch (_) {
      return false;
    }
  });

  for (const tenantId of dirs) {
    console.log(`Restoring session: ${tenantId}`);
    startSession(tenantId).catch((err) =>
      console.error(`Failed to restore ${tenantId}:`, err.message),
    );
  }
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`WA Bridge listening on port ${PORT}`);
  await restoreActiveSessions();
});
