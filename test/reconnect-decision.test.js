const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

/**
 * Carga server.js en un contexto aislado y devuelve la función de decisión.
 *
 * Se carga el fichero entero, y no una copia de la lógica, porque lo que hay
 * que probar es la regla que corre en producción. Es pura: no toca sesiones, no
 * borra ficheros y no habla por la red.
 */
function loadDecision() {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = `${fs.readFileSync(serverPath, "utf8")}\nglobalThis.__bridgeTestExports = { decidirCierreDeConexion, CODIGOS_DE_CREDENCIAL_RECHAZADA, MAX_INTENTOS_CON_CREDENCIAL_RECHAZADA };`;
  const nativeRequire = createRequire(serverPath);

  const app = { use() {}, get() {}, post() {}, listen() { return { close() {} }; } };
  function express() { return app; }
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
    console: { error() {}, log() {}, warn() {} },
    exports: {},
    fetch: async () => new Response("ok", { status: 200 }),
    globalThis: {},
    module: { exports: {} },
    process: { env: { BRIDGE_API_KEY: "k" }, exit() {}, on() {} },
    require: mockRequire,
    setInterval,
    setTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: serverPath });
  return context.__bridgeTestExports;
}

const { decidirCierreDeConexion, CODIGOS_DE_CREDENCIAL_RECHAZADA, MAX_INTENTOS_CON_CREDENCIAL_RECHAZADA } =
  loadDecision();

test("401 cierra la sesion y no la rearranca", () => {
  const d = decidirCierreDeConexion({ code: 401, reconnectAttempts: 12 });
  assert.equal(d.accion, "cerrar_sesion");
});

test("un corte de red reconecta reusando credenciales", () => {
  for (const code of [408, 428, 440, 503]) {
    const d = decidirCierreDeConexion({ code, reconnectAttempts: 0 });
    assert.equal(d.accion, "reconectar", `code ${code}`);
    assert.equal(d.credencialRechazadaAttempts, 0, `code ${code}`);
  }
});

test("515 reconecta de inmediato", () => {
  const d = decidirCierreDeConexion({ code: 515, reconnectAttempts: 3 });
  assert.equal(d.accion, "reconectar");
  assert.equal(d.delay, 0);
});

test("un rechazo de credenciales aislado NO fuerza QR", () => {
  // Una incidencia pasajera de WhatsApp no puede costarle a todos los negocios
  // volver a escanear.
  for (const code of CODIGOS_DE_CREDENCIAL_RECHAZADA) {
    const d = decidirCierreDeConexion({ code, credencialRechazadaAttempts: 0 });
    assert.equal(d.accion, "reconectar", `code ${code}`);
    assert.equal(d.credencialRechazadaAttempts, 1, `code ${code}`);
  }
});

test("credenciales rechazadas de forma seguida acaban regenerando el QR", () => {
  for (const code of CODIGOS_DE_CREDENCIAL_RECHAZADA) {
    let rechazos = 0;
    let accion = null;
    for (let i = 0; i < MAX_INTENTOS_CON_CREDENCIAL_RECHAZADA; i += 1) {
      const d = decidirCierreDeConexion({ code, credencialRechazadaAttempts: rechazos });
      rechazos = d.credencialRechazadaAttempts;
      accion = d.accion;
    }
    assert.equal(accion, "regenerar_qr", `code ${code}`);
  }
});

test("el contador de rechazos se reinicia si por medio hay un corte de red", () => {
  // Dos rechazos, un corte, y otro rechazo no son tres rechazos seguidos: las
  // credenciales podrían estar bien y el problema ser de la red.
  let rechazos = decidirCierreDeConexion({ code: 405 }).credencialRechazadaAttempts;
  rechazos = decidirCierreDeConexion({ code: 405, credencialRechazadaAttempts: rechazos })
    .credencialRechazadaAttempts;
  assert.equal(rechazos, 2);

  rechazos = decidirCierreDeConexion({ code: 408, credencialRechazadaAttempts: rechazos })
    .credencialRechazadaAttempts;
  assert.equal(rechazos, 0);

  const d = decidirCierreDeConexion({ code: 405, credencialRechazadaAttempts: rechazos });
  assert.equal(d.accion, "reconectar");
});

test("el 405 en bucle que dejaba al negocio sin QR ya no puede repetirse", () => {
  // Reproduce lo que se vio en produccion: cierres 405 encadenados. Antes esto
  // daba vueltas para siempre —mas de 15.000 intentos en un tenant— sin emitir
  // jamas un QR. Ahora termina.
  let rechazos = 0;
  let intentos = 0;
  let accion = "reconectar";
  while (accion === "reconectar" && intentos < 1000) {
    const d = decidirCierreDeConexion({ code: 405, credencialRechazadaAttempts: rechazos });
    rechazos = d.credencialRechazadaAttempts;
    accion = d.accion;
    intentos += 1;
  }
  assert.equal(accion, "regenerar_qr");
  assert.ok(intentos <= MAX_INTENTOS_CON_CREDENCIAL_RECHAZADA, `termino en ${intentos} intentos`);
});

test("el backoff de reconexion se topa en 60s", () => {
  const d = decidirCierreDeConexion({ code: 408, reconnectAttempts: 500 });
  assert.equal(d.accion, "reconectar");
  assert.equal(d.delay, 60000);
  assert.equal(d.agotado, true);
});
