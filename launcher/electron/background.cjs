// CLI browser host: no renderer bundle, IPC panel, tray, or updater.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { BrowserHost } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { createLogger, installProcessDiagnosticGuards } = require("./logging.cjs");
const { resolveLauncherProfile } = require("./profile.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { createStateStore } = require("./state.cjs");
const { version } = require("../../package.json");

const profile = resolveLauncherProfile({ appData: app.getPath("appData") });
const sourceRoot = path.resolve(__dirname, "../..");
const descriptorPath = path.join(profile.coreHome, "runtime", "launcher-browser.json");
process.env.CODEX_CHATGPT_WEB_HOME = profile.coreHome;
process.env.CODEX_HOME = profile.codexHome;
app.setName(profile.displayName);
fs.mkdirSync(profile.userData, { recursive: true, mode: 0o700 });
app.setPath("userData", profile.userData);
app.setAppLogsPath(path.join(profile.userData, "logs"));
installProcessDiagnosticGuards({ filePath: path.join(app.getPath("logs"), "process-stream-errors.log") });

let window, host, control, supervisor;
let quitting = false;
let loginRequested = process.argv.includes("--login");
const logger = createLogger({ filePath: path.join(app.getPath("logs"), "background.jsonl"), publish: () => {} });

async function login() {
  loginRequested = true;
  if (!host) return;
  loginRequested = false;
  window.show();
  window.focus();
  await host.openLogin();
  await host.persistSession();
}

async function shutdown(code = 0) {
  if (quitting) return;
  quitting = true;
  try {
    await supervisor?.shutdown({ cancelActiveTurns: false, force: false });
    await host?.persistSession();
    host?.destroy();
    await control?.close();
    app.exit(code);
  } catch (error) {
    quitting = false;
    logger.error("background.shutdown_failed", { message: String(error) });
    process.exitCode = 1;
  }
}

async function start() {
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--login")) void login().catch(error => logger.error("background.login_failed", { message: String(error) }));
  });
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(port));
  await app.whenReady();
  app.dock?.hide();
  const stateStore = createStateStore(path.join(profile.userData, "launcher-state.json"));
  const configPath = path.join(profile.coreHome, "config.json");
  if (fs.existsSync(configPath) && JSON.parse(fs.readFileSync(configPath, "utf8")).browserInteractionMode === "manual") {
    throw new Error("Background mode requires automatic browser interaction; Zero Risk requires the launcher.");
  }
  window = new BrowserWindow({
    width: 1100, height: 800, show: false, title: "ChatGPT sign in",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // CDP must see a committed document for every target, including the empty host window.
  await window.loadURL("about:blank");
  window.setMenuBarVisibility(false);
  window.on("close", event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  control = await new BrowserControlServer({
    logger, getBrowserHost: () => host, getPreferences: () => stateStore.read(),
    resolveProxy: url => session.fromPartition(profile.browserPartition).resolveProxy(url),
    stopRuntime: async () => {
      if (!supervisor) throw new Error("Runtime supervisor is not ready");
      await supervisor.shutdown({ cancelActiveTurns: false, force: false });
    },
  }).start();
  supervisor = new RuntimeSupervisor({
    app: { isPackaged: false, getVersion: () => version }, logger, sourceRoot,
    coreHome: profile.coreHome, browserDescriptorPath: descriptorPath,
    publishOperation: operation => logger.info("background.operation", operation),
  });
  host = new BrowserHost({
    window, descriptorPath, cdpPort: port, control: control.descriptor(), logger,
    partition: profile.browserPartition, profile: profile.kind,
    helper: { executable: process.execPath, script: path.join(sourceRoot, ".launcher-runtime", "browser-helper.cjs") },
    cancelTurn: (traceId, reason) => supervisor.cancelBrowserTurn(traceId, reason),
    getConnectorName: () => supervisor.readConfig()?.appName || "Codex Native2",
    loginWithPasskey: async () => { throw new Error("Use the ChatGPT sign-in window or the existing launcher for passkey recovery."); },
    publishState: () => {}, showWindow: () => { if (loginRequested || window.isVisible()) window.show(); },
    getBrowserInteractionMode: () => "automatic",
  });
  await host.ready();
  const resize = () => {
    const [width, height] = window.getContentSize();
    host.setBounds({ x: 0, y: 0, width, height });
  };
  resize();
  window.on("resize", resize);
  app.on("before-quit", event => { event.preventDefault(); void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  if (loginRequested) void login().catch(error => logger.error("background.login_failed", { message: String(error) }));
  const result = await supervisor.startIfConfigured();
  if (!["ready", "not-configured"].includes(result.status)) throw new Error(result.detail || result.status);
  logger.info("background.ready", { configured: result.status === "ready", pid: process.pid });
}

void start().catch(async error => {
  logger.error("background.start_failed", { message: String(error) });
  process.stderr.write(`codex-chat: ${error.message || error}\n`);
  await shutdown(1);
});
