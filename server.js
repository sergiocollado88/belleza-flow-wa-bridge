// v6 - Multi-session per branch (feature/safe-multi-session-per-branch)
// COMPAT: buildSessionKey(tenantId, null/undefined/'') === tenantId (session principal intacta)
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const WA_WEBHOOK_URL = process.env.WA_WEBHOOK_URL;
const BRIDGE_WEBHOOK_KEY = process.env.BRIDGE_WEBHOOK_KEY;
const BRIDGE_PUBLIC_URL =
  process.env.BRIDGE_PUBLIC_URL ||
  (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null) ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

const MEDIA_CACHE_ROOT = "./media-cache";
const MEDIA_CACHE_TTL_MS = 72 * 60 * 60 * 1000;
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
let warnedMissingBridgeWebhookKey = false;
if (!BRIDGE_API_KEY) {
  console.error("BRIDGE_API_KEY env var is required");
  process.exit(1);
}
if (WA_WEBHOOK_URL && !BRIDGE_WEBHOOK_KEY) {
  warnMissingBridgeWebhookKey();
}

function warnMissingBridgeWebhookKey() {
  if (warnedMissingBridgeWebhookKey) return;
  console.warn("[bridge] BRIDGE_WEBHOOK_KEY env var is not configured; outgoing webhooks will not include x-bridge-api-key");
  warnedMissingBridgeWebhookKey = true;
}

function buildBridgeWebhookKeyDiagnostics() {
  return {
    bridgeWebhookKeyConfigured: Boolean(BRIDGE_WEBHOOK_KEY),
    bridgeWebhookKeyLength: BRIDGE_WEBHOOK_KEY ? BRIDGE_WEBHOOK_KEY.length : null,
    bridgeWebhookKeyHashPrefix: BRIDGE_WEBHOOK_KEY
      ? crypto.createHash("sha256").update(BRIDGE_WEBHOOK_KEY).digest("hex").slice(0, 8)
      : null,
  };
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

let waVersionCache = null;
async function getWAVersion() {
  if (!waVersionCache) {
    const { fetchLatestBaileysVersion } = await getBaileys();
    const { version } = await fetchLatestBaileysVersion();
    waVersionCache = version;
    console.log(`[bridge] WA version pinned: ${version.join(".")}`);
  }
  return waVersionCache;
}

const sessions = new Map();

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
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
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Códigos con los que WhatsApp NO cierra la conexión por un problema de red:
 * cierra porque rechaza las credenciales que le acabamos de presentar.
 *
 *   403 forbidden          — el número está bloqueado o el enlace se revocó
 *   405 connectionFailure  — el servidor rechaza el login; el dispositivo dejó
 *                            de estar enlazado sin llegar a mandar un 401 limpio
 *   500 badSession         — el fichero de sesión ya no es válido
 *
 * Reintentar con las MISMAS credenciales reproduce el mismo cierre, así que
 * insistir no es tolerancia a fallos: es un bucle que no termina nunca. Y
 * mientras dura, Baileys no emite ningún QR —solo lo emite cuando no hay
 * credenciales que presentar—, con lo que el negocio se queda sin forma de
 * volver a enlazar el teléfono.
 */
const CODIGOS_DE_CREDENCIAL_RECHAZADA = Object.freeze([403, 405, 500]);

/**
 * Cuántos cierres seguidos por credencial rechazada se toleran antes de darlas
 * por muertas y volver a pedir QR.
 *
 * No es cero a propósito: un 405 aislado durante una incidencia de WhatsApp no
 * debe costarle a todos los negocios volver a escanear. Tres seguidos, con el
 * backoff de por medio, ya no es una incidencia pasajera.
 */
const MAX_INTENTOS_CON_CREDENCIAL_RECHAZADA = 3;

/**
 * Decide qué hacer con un cierre de conexión. Función pura: no toca sesiones,
 * no borra ficheros y no habla por la red, para poder probar la decisión sin
 * levantar un socket contra WhatsApp.
 *
 * Devuelve una de tres acciones:
 *   · `cerrar_sesion`  — 401: la sesión terminó, se borran credenciales.
 *   · `regenerar_qr`   — las credenciales están muertas: se borran y se arranca
 *                        una sesión nueva, que es lo que produce un QR.
 *   · `reconectar`     — cierre transitorio: se reintenta reusando credenciales.
 */
function decidirCierreDeConexion({
  code,
  reconnectAttempts = 0,
  credencialRechazadaAttempts = 0,
  loggedOutCode = 401,
  restartRequiredCode = 515,
}) {
  if (code === loggedOutCode) {
    return { accion: "cerrar_sesion", delay: 0, reconnectAttempts, credencialRechazadaAttempts: 0 };
  }

  const credencialRechazada = CODIGOS_DE_CREDENCIAL_RECHAZADA.includes(code);
  const rechazos = credencialRechazada ? credencialRechazadaAttempts + 1 : 0;

  if (credencialRechazada && rechazos >= MAX_INTENTOS_CON_CREDENCIAL_RECHAZADA) {
    return {
      accion: "regenerar_qr",
      // Un respiro corto antes de rearrancar: lo suficiente para no encadenar
      // dos arranques en el mismo tick, no tanto como para dejar al negocio
      // mirando una pantalla vacía.
      delay: 2000,
      code,
      rechazos,
      reconnectAttempts: 0,
      credencialRechazadaAttempts: 0,
    };
  }

  const intentos = reconnectAttempts + 1;
  let delay;
  let agotado = false;
  if (code === restartRequiredCode) {
    delay = 0;
  } else if (intentos > MAX_RECONNECT_ATTEMPTS) {
    delay = Math.min(30000 + 5000 * (intentos - MAX_RECONNECT_ATTEMPTS), 60000);
    agotado = true;
  } else {
    delay = Math.min(5000 * intentos, 30000);
  }

  return {
    accion: "reconectar",
    delay,
    agotado,
    reconnectAttempts: intentos,
    credencialRechazadaAttempts: rechazos,
  };
}

function isValidTenantId(name) {
  if (!name || typeof name !== "string") return false;
  if (name.startsWith(".")) return false;
  if (name === "lost-found" || name === "lost+found") return false;
  if (name.length < 2 || name.length > 128) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

// Valida session keys que pueden contener __branch__ (el doble __ pasa porque _ está permitido)
function isValidSessionKey(name) {
  if (!name || typeof name !== "string") return false;
  if (name.startsWith(".")) return false;
  if (name === "lost-found" || name === "lost+found") return false;
  if (name.length < 2 || name.length > 256) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

// ─── HELPERS MULTI-BRANCH ──────────────────────────────────────────────────
// Normaliza branch_id: null/undefined/"" → null
function normalizeBranchId(branchId) {
  if (!branchId || typeof branchId !== "string") return null;
  const trimmed = branchId.trim();
  return trimmed || null;
}

// REGLA CRÍTICA DE COMPATIBILIDAD:
//   buildSessionKey(tenantId, null)        → tenantId  (sesión principal: SIN cambio)
//   buildSessionKey(tenantId, undefined)   → tenantId
//   buildSessionKey(tenantId, "")          → tenantId
//   buildSessionKey(tenantId, branchUuid)  → `${tenantId}__branch__${branchUuid}`
function buildSessionKey(tenantId, branchId) {
  const branch = normalizeBranchId(branchId);
  if (!branch) return tenantId;
  return `${tenantId}__branch__${branch}`;
}

// Ruta en disco para una sessionKey
function getSessionPath(sessionKey) {
  return path.join(SESSIONS_DIR, String(sessionKey));
}

// Contexto legible para logs
function buildLogContext(tenantId, branchId) {
  const branch = normalizeBranchId(branchId);
  const sessionKey = buildSessionKey(tenantId, branchId);
  return `[tenant=${tenantId} branch=${branch || "main"} session=${sessionKey}]`;
}
// ──────────────────────────────────────────────────────────────────────────

function sessionPath(sessionKey) {
  return getSessionPath(sessionKey);
}

function removeSessionFiles(sessionKey) {
  const p = getSessionPath(sessionKey);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
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
  if (!BRIDGE_WEBHOOK_KEY) {
    warnMissingBridgeWebhookKey();
  }
  const tenant_id = payload.tenant_id;
  const branch_id = payload.branch_id ?? null;

  console.log("[BRIDGE_SEND_WEBHOOK]", {
    event,
    tenant_id,
    branch_id,
    url: WA_WEBHOOK_URL ? "configured" : "missing",
    ...buildBridgeWebhookKeyDiagnostics(),
  });

  try {
    const { tenant_id: _, ...data } = payload;
    if (!tenant_id) {
      console.error(`Webhook ${event} skipped: missing tenant_id`);
      return;
    }
    const headers = {
      "Content-Type": "application/json",
    };
    if (BRIDGE_WEBHOOK_KEY) {
      headers["x-bridge-api-key"] = BRIDGE_WEBHOOK_KEY;
    }

    const response = await fetch(WA_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ event, tenant_id, data }),
    });

    const responseBody = await response.text().catch(() => null);

    console.log("[BRIDGE_WEBHOOK_RESPONSE]", {
      event,
      tenant_id,
      branch_id,
      status: response.status,
      ok: response.ok,
      body: responseBody,
    });

    if (!response.ok) {
      console.error(`Webhook ${event} failed: ${response.status} ${responseBody}`);
    }
  } catch (err) {
    console.error(`Webhook ${event} error:`, err.message);
  }
}

async function destroySession(sessionKey, { removeFiles = false } = {}) {
  const existing = sessions.get(sessionKey);
  if (existing?.sock) {
    // CRITICAL: only logout if actually connected — calling logout on a pending
    // QR session invalidates the QR code the user is currently scanning.
    if (existing.status === "connected") {
      try { await existing.sock.logout(); } catch (_) {}
    }
    try { existing.sock.ws?.close?.(); } catch (_) {}
  }
  sessions.delete(sessionKey);
  if (removeFiles) removeSessionFiles(sessionKey);
}

async function startSession(
  tenantId,
  branchId = null,
  { forceFresh = false, reconnectAttempts = 0, credencialRechazadaAttempts = 0 } = {},
) {
  const sessionKey = buildSessionKey(tenantId, branchId);
  const logCtx = buildLogContext(tenantId, branchId);
  const { makeWASocket, useMultiFileAuthState, DisconnectReason } = await getBaileys();
  const existing = sessions.get(sessionKey);
  if (!forceFresh && existing) {
    if (existing.status === "connected") return existing;
    if (existing.status === "qr_pending") return existing;
    if (existing.status === "starting") return existing;
  }
  if (forceFresh) await destroySession(sessionKey, { removeFiles: true });
  ensureSessionsDir();

  const sessionData = {
    sock: null, status: "starting", qrCode: null, phone: null, jid: null,
    startedAt: Date.now(), lidToPhone: new Map(), reconnectAttempts, credencialRechazadaAttempts,
    msgCache: new Map(), sendQueues: new Map(),
    tenantId, branchId: normalizeBranchId(branchId), sessionKey,
  };
  sessions.set(sessionKey, sessionData);

  const { state, saveCreds } = await useMultiFileAuthState(getSessionPath(sessionKey));
  const version = await getWAVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Chrome (Linux)", "Chrome", "120.0.0"],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
      const sess = sessions.get(sessionKey);
      const cached = sess?.msgCache?.get(key.id);
      if (cached) return cached;
      return { conversation: "" };
    },
  });
  sessionData.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  const _syncContacts = (contacts) => {
    const sess = sessions.get(sessionKey);
    if (!sess) return;
    sess.lidToPhone = sess.lidToPhone || new Map();
    for (const c of contacts || []) {
      if (c.id && c.lid) sess.lidToPhone.set(c.lid, c.id);
    }
  };

  sock.ev.on("contacts-set", ({ contacts }) => _syncContacts(contacts));
  sock.ev.on("contacts-upsert", (contacts) => _syncContacts(contacts));

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    const current = sessions.get(sessionKey);
    if (!current || current.sock !== sock) return;

    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      current.status = "qr_pending";
      current.qrCode = qrImage;
      const webhookPayload = { tenant_id: tenantId, qr: qrImage };
      if (current.branchId) webhookPayload.branch_id = current.branchId;
      await sendWebhook("qr_update", webhookPayload);
      console.log(`${logCtx} QR updated`);
    }

    if (connection === "open") {
      const rawSelfId = String(sock.user?.id || "").split(":")[0];
      const phone = normalizePhone(rawSelfId);
      const jid = normalizeJid(rawSelfId);
      current.status = "connected";
      current.qrCode = null;
      current.phone = phone;
      current.jid = jid;
      current.reconnectAttempts = 0; // conexión sana: resetear contador de reintentos
      current.credencialRechazadaAttempts = 0; // y el de credenciales rechazadas

      console.log("[BRIDGE_CONNECTED_EVENT]", {
        tenant_id: tenantId,
        branch_id: current.branchId,
        sessionKey: current.sessionKey,
        phone,
        jid
      });

      const webhookPayload = { tenant_id: tenantId, phone_number: phone, jid };
      if (current.branchId) webhookPayload.branch_id = current.branchId;
      await sendWebhook("connected", webhookPayload);
      console.log(`${logCtx} Connected - phone: ${phone || "unknown"}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      current.qrCode = null;

      const decision = decidirCierreDeConexion({
        code,
        reconnectAttempts: current.reconnectAttempts || 0,
        credencialRechazadaAttempts: current.credencialRechazadaAttempts || 0,
        loggedOutCode: DisconnectReason.loggedOut,
        restartRequiredCode: DisconnectReason.restartRequired,
      });

      // REGLA 1: loggedOut (401) borra credenciales y termina. La sesión no se
      // rearranca sola: hace falta que alguien pida una nueva.
      if (decision.accion === "cerrar_sesion") {
        current.status = "disconnected";
        const dcPayload = { tenant_id: tenantId, reconnecting: false };
        if (current.branchId) dcPayload.branch_id = current.branchId;
        await sendWebhook("disconnected", dcPayload);
        await destroySession(sessionKey, { removeFiles: true });
        console.log(`${logCtx} Logged out (401) — session files removed, QR required`);
        return;
      }

      // REGLA 2: WhatsApp ha rechazado las credenciales varias veces seguidas.
      // Se borran y se arranca una sesión limpia, que es lo único que hace que
      // Baileys vuelva a emitir un QR. Sin esto la sesión se queda en
      // "reconnecting" para siempre —se han visto más de 15.000 intentos— y el
      // negocio no tiene forma de volver a enlazar el teléfono.
      if (decision.accion === "regenerar_qr") {
        current.status = "disconnected";
        current.reconnectAttempts = 0;
        current.credencialRechazadaAttempts = 0;
        const dcPayload = { tenant_id: tenantId, reconnecting: true };
        if (current.branchId) dcPayload.branch_id = current.branchId;
        await sendWebhook("disconnected", dcPayload);
        await destroySession(sessionKey, { removeFiles: true });
        console.warn(
          `${logCtx} Credentials rejected ${decision.rechazos}x (code=${code}) — ` +
            `session files removed, starting fresh session to emit a new QR`,
        );
        setTimeout(async () => {
          // Si alguien ya arrancó una sesión por su cuenta mientras esperábamos,
          // no se pisa: la suya puede estar mostrando un QR a medio escanear.
          if (sessions.has(sessionKey)) return;
          try { await startSession(tenantId, branchId, { forceFresh: true }); }
          catch (err) { console.error(`${logCtx} QR regeneration failed:`, err.message); }
        }, decision.delay);
        return;
      }

      // REGLA 3: cualquier otro motivo (408/428/440/503/515, stream errors, etc.)
      // reconecta reutilizando las credenciales guardadas. NO se borra nada ni se
      // emite "disconnected": es un corte de red, no un rechazo.
      current.status = "reconnecting";
      current.reconnectAttempts = decision.reconnectAttempts;
      current.credencialRechazadaAttempts = decision.credencialRechazadaAttempts;
      const attempts = decision.reconnectAttempts;

      // REGLA 4: al agotar reintentos NO se borran credenciales ni se emite
      // "disconnected": se sigue reintentando con backoff topado (30–60s) y
      // estado "reconnecting".
      if (decision.agotado) {
        console.warn(`${logCtx} Reconnect attempts exhausted (${attempts}) — keeping saved creds, retrying in ${decision.delay}ms`);
      }

      console.log(`${logCtx} Connection closed (code=${code ?? "unknown"}) — reconnecting in ${decision.delay}ms reusing saved creds (attempt ${attempts})`);
      setTimeout(async () => {
        const latest = sessions.get(sessionKey);
        if (!latest || latest.sock !== sock) return;
        const nextAttempts = latest.reconnectAttempts;
        const nextRechazos = latest.credencialRechazadaAttempts;
        sessions.delete(sessionKey);
        try {
          await startSession(tenantId, branchId, {
            forceFresh: false,
            reconnectAttempts: nextAttempts,
            credencialRechazadaAttempts: nextRechazos,
          });
        } catch (err) { console.error(`${logCtx} Reconnect failed:`, err.message); }
      }, decision.delay);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const sess = sessions.get(sessionKey);
    for (const msg of messages) {
      if (sess?.msgCache && msg?.key?.id && msg?.message) {
        sess.msgCache.set(msg.key.id, msg.message);
        if (sess.msgCache.size > 1000) {
          const firstKey = sess.msgCache.keys().next().value;
          sess.msgCache.delete(firstKey);
        }
      }
    }
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg?.key?.fromMe) continue;
      const t0 = Date.now();
      console.log(`${logCtx} [timing] inbound received id=${msg?.key?.id} jid=${msg?.key?.remoteJid}`);
      await handleIncoming(tenantId, branchId, msg);
      console.log(`${logCtx} [timing] inbound processed in ${Date.now() - t0}ms`);
    }
  });

  return sessionData;
}

async function handleIncoming(tenantId, branchId, msg) {
  const sessionKey = buildSessionKey(tenantId, branchId);
  const logCtx = buildLogContext(tenantId, branchId);
  const normalizedBranch = normalizeBranchId(branchId);
  try {
    const remoteJid = normalizeJid(msg?.key?.remoteJid);
    const participantJid = normalizeJid(msg?.key?.participant);

    if (isIgnoredIncomingJid(remoteJid) || isIgnoredIncomingJid(participantJid)) {
      console.log(`${logCtx} Ignored status/broadcast/newsletter message`);
      return;
    }

    const conversationJid =
      (typeof remoteJid === "string" && remoteJid.endsWith("@s.whatsapp.net") ? remoteJid : null) ||
      (typeof participantJid === "string" && participantJid.endsWith("@s.whatsapp.net") ? participantJid : null) ||
      participantJid ||
      remoteJid;

    if (!conversationJid) return;

    let phone = extractRealPhone(msg, sessionKey);
    // Resolve LID → real phone. WhatsApp's privacy LID hides the phone; the real
    // number lives either in the message PN alt fields or Baileys' LID↔PN store.
    if (!phone) {
      const _lidJid = [conversationJid, msg?.key?.remoteJid, msg?.key?.participant]
        .find((j) => typeof j === "string" && j.endsWith("@lid"));
      // 1) PN alt fields that some message types carry
      const _altPn = msg?.key?.remoteJidAlt || msg?.key?.participantAlt ||
        msg?.key?.senderPn || msg?.senderPn ||
        msg?.key?.participantPn || msg?.participantPn || null;
      if (_altPn) phone = normalizePhone(_altPn);
      // 2) Baileys signal LID mapping (populated at decrypt time)
      if (!phone && _lidJid) {
        try {
          const _sess = sessions.get(sessionKey);
          const _map = _sess?.sock?.signalRepository?.lidMapping;
          let _pn = null;
          if (_map?.getPNForLID) _pn = await _map.getPNForLID(_lidJid);
          if (_pn) {
            phone = normalizePhone(_pn);
            if (phone) {
              if (!_sess.lidToPhone) _sess.lidToPhone = new Map();
              _sess.lidToPhone.set(_lidJid, _pn);
              console.log(`${logCtx} LID mapped: ${_lidJid} -> ${phone}`);
            }
          }
        } catch (_e) {
          console.error(`${logCtx} LID map error:`, _e.message);
        }
      }
      // 3) Diagnostic: dump raw key so we can see exactly which field holds the phone
      if (!phone) {
        console.log(`${logCtx} [lid-debug] key=${JSON.stringify(msg?.key || {})} senderPn=${msg?.senderPn || null} participantPn=${msg?.participantPn || null}`);
      }
    }
    const body = extractMessageBody(msg);
    const rawTimestamp = Number(msg?.messageTimestamp || Math.floor(Date.now() / 1000));
    const ts = new Date(rawTimestamp * 1000).toISOString();
    const senderName = String(msg?.pushName || "").trim() || phone || conversationJid;

    // --- EXTRACCIÓN DE FOTOS Y AUDIO (BASE64) ---
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

    if (mimetype && sessions.has(sessionKey)) {
      try {
        const { downloadMediaMessage } = await getBaileys();
        const sock = sessions.get(sessionKey).sock;
        const logger = P({ level: "silent" });
        const buffer = await downloadMediaMessage(
          msg, "buffer", {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
        if (buffer) {
          mediaBase64 = buffer.toString("base64");
          bridgeMediaUrl = buildBridgeMediaUrl(
            tenantId,
            msg?.key?.id || `media_${Date.now()}`,
            mimetype, buffer
          );
        }
      } catch (err) {
        console.error(`${logCtx} Error extrayendo multimedia:`, err.message);
      }
    }
    // -------------------------------------------

    const webhookPayload = {
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
      message: { base64: mediaBase64, mimetype: mimetype || null, messageType },
    };
    if (normalizedBranch) webhookPayload.branch_id = normalizedBranch;

    await sendWebhook("message", webhookPayload);

    console.log(`${logCtx} Incoming from ${senderName} (${phone || "sin-phone"}) jid=${conversationJid}: ${String(body).slice(0, 60)}`);
  } catch (err) {
    console.error(`${logCtx} handleIncoming error:`, err.message);
  }
}

app.get("/health", (_req, res) => { res.json({ ok: true, sessions: sessions.size }); });
app.get("/version", (_req, res) => {
  res.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || "unknown",
    branch: process.env.RAILWAY_GIT_BRANCH || "unknown",
    deployed_at: process.env.RAILWAY_DEPLOYMENT_ID || "unknown",
  });
});
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
    const { tenant_id, branch_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id required" });
    const sessionKey = buildSessionKey(tenant_id, branch_id);
    const existing = sessions.get(sessionKey);
    // CRITICAL: do NOT force a fresh session if one is already showing a QR
    // or still starting — doing so destroys the current QR and the user gets
    // "QR code not valid" when they try to scan the old one.
    const forceFresh = Boolean(
      existing && ["disconnected", "reconnecting"].includes(existing.status)
    );
    const session = await startSession(tenant_id, branch_id || null, { forceFresh });
    return res.json({ success: true, status: session?.status || "starting", qr_code: session?.qrCode || null, phone: session?.phone || null, jid: session?.jid || null, session_key: session?.sessionKey || sessionKey });
  } catch (err) {
    console.error("/session/start error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/session/status/:tenantId", auth, (req, res) => {
  const branch_id = req.query.branch_id || null;
  const sessionKey = buildSessionKey(req.params.tenantId, branch_id);
  const session = sessions.get(sessionKey);
  return res.json({ connected: session?.status === "connected", status: session?.status || "disconnected", qr_code: session?.qrCode || null, phone: session?.phone || null, jid: session?.jid || null, session_key: sessionKey });
});

app.get("/session/debug/:tenantId", auth, (req, res) => {
  try {
    const tenantId = req.params.tenantId;
    const branch_id = req.query.branch_id || null;
    if (!isValidTenantId(tenantId)) return res.status(400).json({ error: "Invalid tenantId" });
    const sessionKey = buildSessionKey(tenantId, branch_id);
    const sessDir = path.resolve(SESSIONS_DIR);
    const sessKeyDir = path.resolve(getSessionPath(sessionKey));
    const session = sessions.get(sessionKey);
    let files = [];
    if (fs.existsSync(sessKeyDir)) {
      try {
        files = fs.readdirSync(sessKeyDir).map((f) => {
          const fp = path.join(sessKeyDir, f);
          let size = null;
          try { size = fs.statSync(fp).size; } catch (_) {}
          return { name: f, size };
        });
      } catch (_) {}
    }
    return res.json({
      sessions_dir: sessDir,
      session_key: sessionKey,
      tenant_dir: sessKeyDir,
      tenant_dir_exists: fs.existsSync(sessKeyDir),
      files,
      session_status: session?.status || "not_in_memory",
      session_phone: session?.phone || null,
      sessions_dir_on_volume: sessDir.startsWith("/data"),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/session/disconnect", auth, async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id required" });
    const sessionKey = buildSessionKey(tenant_id, branch_id);
    const normalizedBranch = normalizeBranchId(branch_id);
    await destroySession(sessionKey, { removeFiles: true });
    const webhookPayload = { tenant_id, reconnecting: false };
    if (normalizedBranch) webhookPayload.branch_id = normalizedBranch;
    await sendWebhook("disconnected", webhookPayload);
    return res.json({ success: true, session_key: sessionKey });
  } catch (err) {
    console.error("/session/disconnect error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/session/send", auth, async (req, res) => {
  try {
    const { tenant_id, branch_id, phone, recipient_jid, message } = req.body;
    if (!tenant_id || !message) return res.status(400).json({ error: "tenant_id and message required" });
    const sessionKey = buildSessionKey(tenant_id, branch_id);
    const logCtx = buildLogContext(tenant_id, branch_id);

    const session = sessions.get(sessionKey);
    if (!session?.sock || session.status !== "connected") {
      return res.status(404).json({ error: "Session not found or not connected" });
    }

    let jid = null;
    const target = recipient_jid || phone;
    if (target) {
      const justNumbers = String(target).replace(/\D/g, "");
      if (justNumbers) jid = `${justNumbers}@s.whatsapp.net`;
    }
    if (!jid) return res.status(400).json({ error: "phone or recipient_jid required" });

    const t0 = Date.now();
    console.log(`${logCtx} [timing] send start jid=${jid}`);

    const prev = (session.sendQueues.get(jid) || Promise.resolve()).catch(() => {});
    let gateResolve;
    const gate = new Promise((r) => { gateResolve = r; });
    session.sendQueues.set(jid, gate.catch(() => {}));

    const result = await prev.then(async () => {
      const tSend = Date.now();
      console.log(`${logCtx} [timing] sock.sendMessage start jid=${jid} queue_wait=${tSend - t0}ms`);
      const r = await session.sock.sendMessage(jid, { text: String(message) });
      const tDone = Date.now();
      console.log(`${logCtx} [timing] sock.sendMessage done id=${r?.key?.id} send_ms=${tDone - tSend}ms`);
      if (r?.key?.id && session.msgCache) {
        session.msgCache.set(r.key.id, { conversation: String(message) });
        if (session.msgCache.size > 1000) {
          const firstKey = session.msgCache.keys().next().value;
          session.msgCache.delete(firstKey);
        }
      }
      setTimeout(() => gateResolve(), 600);
      return r;
    });

    console.log(`${logCtx} [timing] send total=${Date.now() - t0}ms id=${result?.key?.id}`);
    return res.json({ success: true, jid, message_id: result?.key?.id || null });
  } catch (err) {
    console.error(`${buildLogContext(req.body?.tenant_id || "unknown", req.body?.branch_id)} Send error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function restoreActiveSessions() {
  ensureSessionsDir();
  const dirs = fs.readdirSync(SESSIONS_DIR).filter((d) => {
    if (d.startsWith(".")) return false;
    if (d === "lost-found" || d === "lost+found") return false;
    if (!isValidSessionKey(d)) {
      console.warn(`Skipping invalid session directory: ${SESSIONS_DIR}/${d}`);
      return false;
    }
    try { return fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory(); } catch (_) { return false; }
  });
  if (dirs.length === 0) { console.log("No sessions to restore"); return; }
  for (const sessionKey of dirs) {
    // Detectar si es sesión principal (tenant_id) o de sucursal (tenant__branch__branch_id)
    const parts = sessionKey.split("__branch__");
    const tenantId = parts[0];
    const branchId = parts.length > 1 ? parts[1] : null;
    const logCtx = buildLogContext(tenantId, branchId);
    console.log(`Restoring session: ${logCtx}`);
    startSession(tenantId, branchId, { forceFresh: false })
      .catch((err) => console.error(`Failed to restore ${logCtx}:`, err.message));
  }
}

async function gracefulShutdown(signal) {
  console.log(`[bridge] ${signal} received — shutting down gracefully`);
  const tenantIds = [...sessions.keys()];
  for (const tenantId of tenantIds) {
    try {
      await destroySession(tenantId, { removeFiles: false });
      console.log(`[bridge] Session ${tenantId} closed`);
    } catch (err) {
      console.error(`[bridge] Error closing session ${tenantId}:`, err.message);
    }
  }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`WA Bridge listening on port ${PORT}`);
  console.log(`[bridge] Sessions directory: ${path.resolve(SESSIONS_DIR)}`);
  await restoreActiveSessions();
});
