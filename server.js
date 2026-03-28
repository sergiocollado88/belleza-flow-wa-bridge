const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const P = require("pino");
const { createClient } = require("@supabase/supabase-js");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Session store ─────────────────────────────────────────────────────────
const sessions = new Map();

// ─── Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Start / restore a WhatsApp session ────────────────────────────────────
async function startSession(tenantId) {
  const existing = sessions.get(tenantId);
  if (existing) {
    try {
      const state = existing.ws?.readyState;
      if (state === 1) return;
    } catch (_) {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(
    `./sessions/${tenantId}`
  );
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Belleza Flow", "Chrome", "1.0"],
  });

  sessions.set(tenantId, sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      await supabase.from("whatsapp_sessions").upsert(
        {
          tenant_id: tenantId,
          status: "qr_pending",
          qr_code: qrImage,
          phone_number: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" }
      );
      console.log(`[${tenantId}] QR updated`);
    }

    if (connection === "open") {
      const phone = (sock.user?.id || "").split(":")[0].replace(/\D/g, "");
      await supabase.from("whatsapp_sessions").upsert(
        {
          tenant_id: tenantId,
          status: "connected",
          qr_code: null,
          phone_number: phone,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" }
      );
      console.log(`[${tenantId}] Connected — phone: ${phone}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      sessions.delete(tenantId);

      await supabase.from("whatsapp_sessions").upsert(
        {
          tenant_id: tenantId,
          status: loggedOut ? "disconnected" : "reconnecting",
          qr_code: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" }
      );

      if (!loggedOut) {
        console.log(`[${tenantId}] Reconnecting in 5s`);
        setTimeout(() => startSession(tenantId), 5000);
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
}

// ─── Save incoming WA message to Supabase ─────────────────────────────────
async function handleIncoming(tenantId, msg) {
  const jid = msg.key.remoteJid || "";
  if (jid.endsWith("@g.us")) return;

  const phone = jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "[media]";
  const ts = new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString();

  let { data: conv } = await supabase
    .from("conversations")
    .select("id, unread_count")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .eq("channel", "whatsapp")
    .maybeSingle();

  if (!conv) {
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        phone,
        channel: "whatsapp",
        contact_name: phone,
        status: "nuevo",
        unread_count: 1,
        last_message_at: ts,
        last_message_preview: body.slice(0, 120),
      })
      .select("id, unread_count")
      .single();
    conv = newConv;
  } else {
    await supabase
      .from("conversations")
      .update({
        unread_count: (conv.unread_count || 0) + 1,
        last_message_at: ts,
        last_message_preview: body.slice(0, 120),
      })
      .eq("id", conv.id);
  }

  if (conv?.id) {
    await supabase.from("messages").insert({
      conversation_id: conv.id,
      body,
      direction: "inbound",
      channel: "whatsapp",
      created_at: ts,
      status: "received",
      wa_message_id: msg.key.id || null,
    });
  }
  console.log(`[${tenantId}] Incoming from ${phone}: ${body.slice(0, 40)}`);
}

// ─── REST endpoints ─────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/session/start", auth, async (req, res) => {
  const { tenant_id } = req.body;
  if (!tenant_id) return res.status(400).json({ error: "tenant_id required" });
  await startSession(tenant_id);
  res.json({ success: true });
});

app.post("/session/disconnect", auth, async (req, res) => {
  const { tenant_id } = req.body;
  const sock = sessions.get(tenant_id);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sessions.delete(tenant_id);
  }
  const fs = require("fs");
  const path = `./sessions/${tenant_id}`;
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true });

  await supabase.from("whatsapp_sessions").upsert(
    {
      tenant_id,
      status: "disconnected",
      qr_code: null,
      phone_number: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" }
  );
  res.json({ success: true });
});

app.post("/session/send", auth, async (req, res) => {
  const { tenant_id, phone, message } = req.body;
  const sock = sessions.get(tenant_id);
  if (!sock) return res.status(404).json({ error: "Session not found or disconnected" });

  try {
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/status/:tenantId", auth, async (req, res) => {
  const sock = sessions.get(req.params.tenantId);
  res.json({ connected: !!sock });
});

// ─── On startup: restore sessions ─────────────────────────────────────────
async function restoreActiveSessions() {
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("tenant_id")
    .in("status", ["connected", "reconnecting"]);

  for (const { tenant_id } of data || []) {
    console.log(`Restoring session: ${tenant_id}`);
    await startSession(tenant_id);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`WA Bridge listening on port ${PORT}`);
  await restoreActiveSessions();
});
