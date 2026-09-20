#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertDurableRuntimeCommand, atomicWriteFile, getConfigDir, loadConfig } from "./config";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { runCommand, runChecked } from "./process";

const ROOT = resolve(import.meta.dir, "..");
export const LABEL = "io.github.codex-chatgpt-web.background";
const target = () => `gui/${userInfo().uid}/${LABEL}`;
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const settingsPath = () => join(getConfigDir(), "cli.json");
const descriptorPath = () => join(getConfigDir(), "runtime", "launcher-browser.json");
const entry = join(ROOT, "launcher", "electron", "background.cjs");
const electron = join(ROOT, "launcher", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");

export interface Settings { profile: string; codexHome: string; setupHome: string; }

export function prepareProfile(profile: string, codexHome: string, bridgeHome: string): Settings {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) throw new Error("Invalid profile name");
  const profilePath = join(codexHome, `${profile}.config.toml`);
  const journalPath = join(bridgeHome, "codex", "integration-journal.json");
  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    if (typeof journal.configPath !== "string" || !existsSync(profilePath)
      || realpathSync(journal.configPath) !== realpathSync(profilePath)) {
      throw new Error("Existing integration belongs to another Codex config; keep its profile or uninstall it first.");
    }
    return { profile, codexHome, setupHome: dirname(journal.configPath) };
  }
  const setupHome = join(bridgeHome, "codex-profile");
  const configPath = join(setupHome, "config.toml");
  if (existsSync(configPath) || (() => { try { return lstatSync(configPath).isSymbolicLink(); } catch { return false; } })()) {
    if (!existsSync(profilePath) || realpathSync(configPath) !== realpathSync(profilePath)) {
      throw new Error("CLI setup home already points to another configuration");
    }
  }
  if (!existsSync(profilePath)) atomicWriteFile(profilePath, `# ChatGPT Web profile, managed by codex-chat setup.
model_provider = "openai"
model = "chatgpt-web/high"
model_reasoning_effort = "high"
web_search = "disabled"
approvals_reviewer = "user"

[features]
multi_agent = false
multi_agent_v2 = false
image_generation = false
memories = false
`);
  mkdirSync(setupHome, { recursive: true, mode: 0o700 });
  if (!existsSync(configPath)) symlinkSync(profilePath, configPath);
  return { profile, codexHome, setupHome };
}

function settings(): Settings {
  if (!existsSync(settingsPath())) throw new Error("Run codex-chat install first.");
  const value = JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.profile)
    || !value.codexHome?.startsWith("/") || !value.setupHome?.startsWith("/")) throw new Error("Invalid CLI settings");
  return value;
}

function environment(value: Settings) {
  return { ...process.env, CODEX_CHATGPT_WEB_HOME: getConfigDir(), CODEX_HOME: value.setupHome,
    CODEX_CHATGPT_WEB_BUN: process.execPath, CODEX_WEB_GPT_BUN: process.execPath };
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function servicePlist(args: string[], env: Record<string, string>, logs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>45</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "background.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "background.stderr.log"))}</string>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
}

function servicePid(): number | undefined {
  const result = runCommand("launchctl", ["print", target()]);
  if (result.status !== 0) return undefined;
  return Number(result.stdout.match(/\bpid = (\d+)/)?.[1]) || 0;
}

async function health() {
  try {
    const config = loadConfig();
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    return body.service === "codex-chatgpt-web" && body.status === "ok" ? body : null;
  } catch { return null; }
}

async function status() {
  const pid = servicePid();
  let browserReady = false;
  try { browserReady = readLauncherBrowserHostDescriptor(descriptorPath()).pid === pid; } catch {}
  return { installed: existsSync(plistPath()), loaded: pid !== undefined, pid: pid || null,
    browserReady, runtime: browserReady ? await health() : null };
}

async function waitReady() {
  const configured = existsSync(join(getConfigDir(), "config.json"));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await status();
    if (current.browserReady && (!configured || current.runtime?.accepting_turns === true)) return;
    await Bun.sleep(250);
  }
  throw new Error(`Background service did not become ready. Check ${join(getConfigDir(), "logs", "background.stderr.log")}`);
}

async function start() {
  if (!existsSync(plistPath())) throw new Error("Run codex-chat install first.");
  const pid = servicePid();
  if (pid === undefined) runChecked("launchctl", ["bootstrap", `gui/${userInfo().uid}`, plistPath()]);
  else if (pid === 0) runChecked("launchctl", ["kickstart", target()]);
  await waitReady();
}

async function stopRuntime(pid = servicePid()) {
  if (pid === undefined) return;
  if (pid > 0) {
    // Health failure is not evidence of idleness. Ask the authenticated owner to drain
    // and stop its children before launchd is allowed to terminate the browser host.
    const descriptor = readLauncherBrowserHostDescriptor(descriptorPath());
    if (descriptor.pid !== pid) throw new Error("Background browser ownership could not be verified; refusing to stop.");
    const response = await fetch(`${descriptor.control.endpoint}/v1/runtime/stop`, {
      method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
      body: "{}", signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) {
      throw new Error("Runtime did not acknowledge an idle stop; finish the active task and retry.");
    }
  }
}

async function stop() {
  const pid = servicePid();
  if (pid === undefined) return;
  await stopRuntime(pid);
  runChecked("launchctl", ["bootout", target()]);
  const deadline = Date.now() + 45_000;
  while (servicePid() !== undefined && Date.now() < deadline) await Bun.sleep(100);
  if (servicePid() !== undefined) throw new Error("Background service did not stop");
}

async function bridge(args: string[], value = settings()) {
  const child = Bun.spawn([process.execPath, join(ROOT, "src", "cli.ts"), ...args], {
    env: environment(value), stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Bridge command failed (exit ${code})`);
}

async function install(args: string[]) {
  const requested = args[0] === "--profile" && args.length === 2 ? args[1]! : undefined;
  if (args.length && !requested) throw new Error("Usage: codex-chat install [--profile NAME]");
  if (!existsSync(electron)) throw new Error("Install Electron first: cd launcher && bun install --frozen-lockfile");
  assertDurableRuntimeCommand([electron, entry]);
  if (servicePid() === undefined) {
    let active = false;
    try { readLauncherBrowserHostDescriptor(descriptorPath()); active = true; } catch {}
    if (active) throw new Error("Quit Codex Web GPT before installing the background service; it owns this browser session.");
  }
  const previous = existsSync(settingsPath()) ? settings() : undefined;
  const value = prepareProfile(requested || previous?.profile || "chat",
    previous?.codexHome || resolve(process.env.CODEX_HOME || join(homedir(), ".codex")), getConfigDir());
  runChecked(process.execPath, [join(ROOT, "scripts", "build-browser-helper.ts")]);
  const logs = join(getConfigDir(), "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const env = environment(value);
  const definition = servicePlist([electron, entry], {
    CODEX_HOME: env.CODEX_HOME, CODEX_CHATGPT_WEB_HOME: env.CODEX_CHATGPT_WEB_HOME,
    CODEX_CHATGPT_WEB_BUN: env.CODEX_CHATGPT_WEB_BUN, CODEX_WEB_GPT_BUN: env.CODEX_WEB_GPT_BUN,
    ...(process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR ? { CODEX_WEB_GPT_LAUNCHER_DATA_DIR: process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR } : {}),
  }, logs);
  if (servicePid() !== undefined && readFileSync(plistPath(), "utf8") !== definition) await stop();
  atomicWriteFile(settingsPath(), `${JSON.stringify(value, null, 2)}\n`);
  atomicWriteFile(plistPath(), definition, { protectDirectory: false });
  await start();
  console.log(`Background service installed. Run codex-chat or codex --profile ${value.profile}.`);
}

export function installCliWrapper(target: string, bun: string, script: string): void {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const marker = "# Managed by codex-chatgpt-web CLI installer.\n";
  const content = `#!/bin/sh\n${marker}exec ${quote(bun)} ${quote(script)} "$@"\n`;
  let stat;
  try { stat = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (stat && (!stat.isFile() || (!readFileSync(target, "utf8").startsWith(`#!/bin/sh\n${marker}`)
    && readFileSync(target, "utf8") !== content.replace(marker, "")))) {
    throw new Error(`Refusing to overwrite an unrelated command: ${target}`);
  }
  atomicWriteFile(target, content, { mode: 0o700, protectDirectory: false });
}

const HELP = `codex-chat — ChatGPT Web from your terminal (macOS)
  install [--profile NAME]  Install/start the login service; default profile: chat
  start | stop | restart  Control browser, bridge, and tunnel together
  status                  Print service health as JSON
  login                   Open ChatGPT only for sign-in; closing it keeps service running
  setup [bridge options]  Configure bridge through CLI; reuse saved tunnel/key
  doctor                  Check account, bridge, and tunnel
  uninstall               Remove login service; keep account and profile
  run [Codex arguments]   Start service and run Codex with the separate profile
  -- [Codex arguments]    Same as run (no arguments opens interactive Codex)

First setup: install, login, setup --full --tunnel-id ID --runtime-key-file PATH --acknowledge-unofficial
Existing launcher setup: quit launcher, then install. No new key or login required.
`;

export async function main(args: string[]) {
  if (args[0] === "--help" || args[0] === "-h") { console.log(HELP); return; }
  if (process.platform !== "darwin") throw new Error("codex-chat background services currently require macOS.");
  const command = args.shift() || "run";
  if (command === "install") return await install(args);
  if (!["run", "--", "setup"].includes(command) && args.length) throw new Error(`Unexpected arguments for ${command}`);
  if (command === "status") { console.log(JSON.stringify(await status(), null, 2)); return; }
  if (command === "stop") { await stop(); return; }
  if (command === "uninstall") { await stop(); rmSync(plistPath(), { force: true }); return; }
  if (command === "restart") { await stop(); await start(); return; }
  if (command === "start") { await start(); return; }
  const value = settings();
  if (command === "doctor") return await bridge(["doctor"], value);
  if (command === "login") {
    await start();
    runChecked(electron, [entry, "--login"], { env: environment(value) });
    console.log("Complete ChatGPT sign-in in the browser window, then close it.");
    return;
  }
  if (command === "setup") {
    let existing;
    if (existsSync(join(getConfigDir(), "config.json"))) existing = loadConfig();
    if (!args.includes("--full") && !args.includes("--browser-only")) args.unshift(existing?.mode === "browser-only" ? "--browser-only" : "--full");
    if (existing?.acknowledgedUnofficialAt && !args.includes("--acknowledge-unofficial")) args.push("--acknowledge-unofficial");
    await start();
    await stopRuntime();
    try {
      await bridge(["setup", "--browser-host-descriptor", descriptorPath(), "--subagent-protocol", "native", ...args], value);
    } finally {
      // Keep the browser available for capability inspection, then reload the committed config.
      await stop(); await start();
    }
    return;
  }
  if (command !== "run" && command !== "--") throw new Error(`Unknown command: ${command}\n${HELP}`);
  await start();
  const child = Bun.spawn(["codex", "--profile", value.profile, ...args], {
    env: { ...process.env, CODEX_HOME: value.codexHome }, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => {
  console.error(`codex-chat: ${error.message || error}`);
  process.exitCode = 1;
});
