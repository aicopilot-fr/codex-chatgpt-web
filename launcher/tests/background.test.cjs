const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../electron/background.cjs"),
  "utf8",
);

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function boot({ args = [], lock = true, manual = false } = {}) {
  const events = [];
  const root = path.join(__dirname, ".background-fixture");
  const profile = {
    coreHome: path.join(root, "core"),
    codexHome: path.join(root, "codex"),
    displayName: "Codex Web GPT test",
    userData: path.join(root, "user-data"),
    browserPartition: "persist:codex-web-gpt-test",
    kind: "production",
  };
  const app = new EventEmitter();
  app.getPath = name => name === "appData" ? root : path.join(root, name);
  app.setName = name => events.push(["app.setName", name]);
  app.setPath = (...values) => events.push(["app.setPath", ...values]);
  app.setAppLogsPath = value => events.push(["app.setAppLogsPath", value]);
  app.requestSingleInstanceLock = () => lock;
  app.whenReady = async () => { events.push("app.whenReady"); };
  app.exit = code => events.push(["app.exit", code]);
  app.commandLine = { appendSwitch: (...values) => events.push(["appendSwitch", ...values]) };
  app.dock = { hide: () => events.push("dock.hide") };

  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = options.show === true;
      this.showCalls = 0;
      this.focusCalls = 0;
      this.hideCalls = 0;
      this.loadCalls = [];
      events.push(["window.create", options]);
    }

    show() { this.showCalls += 1; this.visible = true; events.push("window.show"); }
    focus() { this.focusCalls += 1; events.push("window.focus"); }
    hide() { this.hideCalls += 1; this.visible = false; events.push("window.hide"); }
    isVisible() { return this.visible; }
    setMenuBarVisibility(value) { events.push(["window.menu", value]); }
    getContentSize() { return [this.options.width, this.options.height]; }
    loadURL(url) { this.loadCalls.push(url); }
  }

  let window;
  let host;
  let control;
  let supervisor;
  const processMock = new EventEmitter();
  processMock.argv = ["node", "background.cjs", ...args];
  processMock.env = {};
  processMock.execPath = process.execPath;
  processMock.pid = 4242;
  processMock.stderr = { write: value => events.push(["stderr", value]) };
  processMock.exitCode = undefined;

  const fsMock = {
    mkdirSync: (...values) => events.push(["mkdirSync", ...values]),
    existsSync: value => manual && value === path.join(profile.coreHome, "config.json"),
    readFileSync: () => JSON.stringify({ browserInteractionMode: "manual" }),
  };
  const netMock = {
    createServer() {
      const server = new EventEmitter();
      server.listen = (_port, _host, callback) => {
        events.push(["net.listen", _port, _host]);
        callback();
      };
      server.address = () => ({ port: 43123 });
      server.close = callback => {
        events.push("net.close");
        callback();
      };
      return server;
    },
  };

  class FakeBrowserHost {
    constructor(options) {
      this.options = options;
      this.persistCalls = 0;
      this.openLoginCalls = 0;
      host = this;
      events.push("host.create");
    }

    async ready() { events.push("host.ready"); }
    async openLogin() { this.openLoginCalls += 1; events.push("host.openLogin"); }
    async persistSession() { this.persistCalls += 1; events.push("host.persistSession"); }
    destroy() { events.push("host.destroy"); }
    setBounds(bounds) { events.push(["host.setBounds", bounds]); }
  }

  class FakeControlServer {
    constructor(options) { this.options = options; control = this; }
    async start() { events.push("control.start"); return this; }
    descriptor() { return { host: "127.0.0.1", port: 43124 }; }
    async close() { events.push("control.close"); }
  }

  class FakeSupervisor {
    constructor(options) { this.options = options; supervisor = this; }
    async startIfConfigured() { events.push("supervisor.start"); return { status: "not-configured" }; }
    async shutdown(options) { events.push(["supervisor.shutdown", options]); }
    cancelBrowserTurn() {}
    readConfig() { return { appName: "Codex Native2" }; }
  }

  const logger = {
    info: (event, detail) => events.push(["log.info", event, detail]),
    error: (event, detail) => events.push(["log.error", event, detail]),
  };
  const modules = {
    electron: {
      app,
      BrowserWindow: class extends FakeWindow {
        constructor(options) { super(options); window = this; }
      },
      session: { fromPartition: () => ({ resolveProxy: async () => "DIRECT" }) },
    },
    "./browser-host.cjs": { BrowserHost: FakeBrowserHost },
    "./control-server.cjs": { BrowserControlServer: FakeControlServer },
    "./logging.cjs": {
      createLogger: () => logger,
      installProcessDiagnosticGuards: options => events.push(["diagnostics", options]),
    },
    "./profile.cjs": { resolveLauncherProfile: () => profile },
    "./runtime-supervisor.cjs": { RuntimeSupervisor: FakeSupervisor },
    "./state.cjs": { createStateStore: () => ({ read: () => ({}) }) },
    "../../package.json": { version: "5.0.8" },
    "node:fs": fsMock,
    "node:net": netMock,
    "node:path": path,
  };
  const sandbox = {
    require(request) {
      if (!(request in modules)) throw new Error(`Unexpected require: ${request}`);
      return modules[request];
    },
    __dirname: path.join(__dirname, "../electron"),
    process: processMock,
    console,
    Buffer,
    clearTimeout,
    queueMicrotask,
    setImmediate,
    setTimeout,
  };

  vm.runInNewContext(source, sandbox, { filename: path.join(__dirname, "../electron/background.cjs") });
  await settle();
  return { app, control, events, host, process: processMock, supervisor, window };
}

test("background startup keeps its window hidden and never loads a renderer", async () => {
  const fixture = await boot();

  assert.equal(fixture.window.options.show, false);
  assert.equal(fixture.window.showCalls, 0);
  assert.equal(fixture.window.isVisible(), false);
  assert.deepEqual(fixture.window.loadCalls, ["about:blank"]);
  assert.ok(fixture.events.includes("host.ready"));
});

test("explicit login shows sign-in after hidden startup", async () => {
  const fixture = await boot({ args: ["--login"] });

  assert.equal(fixture.window.showCalls, 1);
  assert.equal(fixture.window.focusCalls, 1);
  assert.equal(fixture.host.openLoginCalls, 1);
  assert.equal(fixture.host.persistCalls, 1);
});

test("second instance opens sign-in only when it requests login", async () => {
  const fixture = await boot();

  fixture.app.emit("second-instance", {}, ["background", "--login"]);
  await settle();
  assert.equal(fixture.window.showCalls, 1);
  assert.equal(fixture.host.openLoginCalls, 1);
  assert.equal(fixture.host.persistCalls, 1);

  fixture.app.emit("second-instance", {}, ["background"]);
  await settle();
  assert.equal(fixture.window.showCalls, 1);
  assert.equal(fixture.host.openLoginCalls, 1);
});

test("closing hidden background window prevents close and hides it", async () => {
  const fixture = await boot();
  let prevented = false;

  fixture.window.emit("close", { preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(fixture.window.hideCalls, 1);
  assert.equal(fixture.window.isVisible(), false);
});

test("shutdown stops supervisor, persists session, then destroys owned services", async () => {
  const fixture = await boot();
  const start = fixture.events.length;
  let prevented = false;

  fixture.app.emit("before-quit", { preventDefault: () => { prevented = true; } });
  await settle();

  assert.equal(prevented, true);
  const shutdownEvents = fixture.events.slice(start);
  assert.equal(shutdownEvents[0][0], "supervisor.shutdown");
  assert.equal(shutdownEvents[0][1].cancelActiveTurns, false);
  assert.equal(shutdownEvents[0][1].force, false);
  assert.deepEqual(shutdownEvents.slice(1), [
    "host.persistSession",
    "host.destroy",
    "control.close",
    ["app.exit", 0],
  ]);
});

test("manual browser interaction is rejected before background window creation", async () => {
  const fixture = await boot({ manual: true });

  assert.equal(fixture.window, undefined);
  assert.deepEqual(fixture.events.filter(event => Array.isArray(event) && event[0] === "app.exit"), [["app.exit", 1]]);
  assert.match(
    fixture.events.find(event => Array.isArray(event) && event[0] === "stderr")[1],
    /Background mode requires automatic browser interaction/,
  );
});

test("single-instance lock exits without starting Electron services", async () => {
  const fixture = await boot({ lock: false });

  assert.deepEqual(fixture.events.filter(event => Array.isArray(event) && event[0] === "app.exit"), [["app.exit", 0]]);
  assert.equal(fixture.events.includes("app.whenReady"), false);
  assert.equal(fixture.window, undefined);
  assert.equal(fixture.events.some(event => Array.isArray(event) && event[0] === "net.listen"), false);
});
