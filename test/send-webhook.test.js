const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBridge({ env, fetchImpl, logImpl = () => {}, warnImpl = () => {} }) {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}\nglobalThis.__bridgeTestExports = { sendWebhook };`;
  const nativeRequire = createRequire(serverPath);

  const app = {
    use() {},
    get() {},
    post() {},
    listen() {
      return { close() {} };
    },
  };

  function express() {
    return app;
  }
  express.json = () => (_req, _res, next) => next?.();
  express.urlencoded = () => (_req, _res, next) => next?.();

  function mockRequire(id) {
    if (id === "express") return express;
    if (id === "cors") return () => (_req, _res, next) => next?.();
    if (id === "pino") return () => ({});
    if (id === "qrcode") return {};
    return nativeRequire(id);
  }

  const context = {
    Buffer,
    URL,
    __dirname: path.dirname(serverPath),
    __filename: serverPath,
    clearInterval,
    clearTimeout,
    console: {
      error() {},
      log: logImpl,
      warn: warnImpl,
    },
    exports: {},
    fetch: fetchImpl,
    globalThis: {},
    module: { exports: {} },
    process: {
      env,
      exit(code) {
        throw new Error(`process.exit(${code})`);
      },
      on() {},
    },
    require: mockRequire,
    setInterval,
    setTimeout,
  };

  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: serverPath });
  return context.__bridgeTestExports;
}

test("sendWebhook authenticates outgoing webhook events with BRIDGE_WEBHOOK_KEY", async () => {
  let request;
  const logs = [];
  const { sendWebhook } = loadBridge({
    env: {
      BRIDGE_API_KEY: "control-key",
      BRIDGE_WEBHOOK_KEY: "webhook-key",
      WA_WEBHOOK_URL: "https://example.test/webhook",
    },
    logImpl: (...args) => logs.push(args),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response("ok", { status: 200 });
    },
  });

  await sendWebhook("qr_update", { tenant_id: "tenant-1", qr: "qr-data" });

  assert.equal(request.url, "https://example.test/webhook");
  assert.equal(request.options.headers["x-bridge-api-key"], "webhook-key");
  assert.equal(request.options.headers["x-webhook-secret"], undefined);
  assert.notEqual(request.options.headers["x-bridge-api-key"], "control-key");

  const sendLog = logs.find(([label]) => label === "[BRIDGE_SEND_WEBHOOK]");
  assert.ok(sendLog);
  assert.equal(sendLog[1].bridgeWebhookKeyConfigured, true);
  assert.equal(sendLog[1].bridgeWebhookKeyLength, "webhook-key".length);
  assert.equal(sendLog[1].bridgeWebhookKeyHashPrefix, "bb6a6ea1");
  assert.doesNotMatch(JSON.stringify(sendLog[1]), /webhook-key|control-key/);
});

test("sendWebhook warns when BRIDGE_WEBHOOK_KEY is missing", async () => {
  const warnings = [];
  const { sendWebhook } = loadBridge({
    env: {
      BRIDGE_API_KEY: "control-key",
      WA_WEBHOOK_URL: "https://example.test/webhook",
    },
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    warnImpl: (message) => warnings.push(message),
  });

  await sendWebhook("qr_update", { tenant_id: "tenant-1", qr: "qr-data" });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /BRIDGE_WEBHOOK_KEY/);
  assert.doesNotMatch(warnings[0], /control-key/);
});
