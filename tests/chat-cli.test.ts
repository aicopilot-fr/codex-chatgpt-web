import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCliWrapper, prepareProfile, servicePlist } from "../src/chat-cli";

test("CLI setup isolates the named profile and can be repeated without copying account state", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chat-cli-"));
  try {
    const codex = join(root, "codex");
    const bridge = join(root, "bridge");
    mkdirSync(codex);
    writeFileSync(join(codex, "config.toml"), 'model = "original"\n');
    writeFileSync(join(codex, "auth.json"), 'synthetic-account-fixture');
    const result = prepareProfile("chat", codex, bridge);
    const profile = readFileSync(join(codex, "chat.config.toml"), "utf8");
    expect(prepareProfile("chat", codex, bridge)).toEqual(result);
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe('model = "original"\n');
    expect(realpathSync(join(result.setupHome, "config.toml"))).toBe(realpathSync(join(codex, "chat.config.toml")));
    expect(Bun.TOML.parse(profile)).toMatchObject({ model: "chatgpt-web/high", features: { multi_agent: false, multi_agent_v2: false, image_generation: false, memories: false } });
    expect(statSync(join(codex, "chat.config.toml")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(result.setupHome, "auth.json"))).toBeFalse();
    expect(existsSync(join(result.setupHome, "sessions"))).toBeFalse();
    expect(() => prepareProfile("../escape", codex, bridge)).toThrow("Invalid profile name");
    expect(() => prepareProfile("another", codex, bridge)).toThrow("another configuration");
    expect(existsSync(join(codex, "another.config.toml"))).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing launcher integration is adopted only when it targets the requested profile", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chat-adopt-"));
  try {
    const codex = join(root, "codex"), bridge = join(root, "bridge"), setupHome = join(root, "existing");
    mkdirSync(codex); mkdirSync(setupHome); mkdirSync(join(bridge, "codex"), { recursive: true });
    writeFileSync(join(codex, "chat.config.toml"), 'model = "custom"\n');
    symlinkSync(join(codex, "chat.config.toml"), join(setupHome, "config.toml"));
    writeFileSync(join(bridge, "codex", "integration-journal.json"), JSON.stringify({ configPath: join(setupHome, "config.toml") }));
    expect(prepareProfile("chat", codex, bridge).setupHome).toBe(setupHome);
    expect(readFileSync(join(codex, "chat.config.toml"), "utf8")).toBe('model = "custom"\n');
    expect(() => prepareProfile("other", codex, bridge)).toThrow("another Codex config");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("LaunchAgent preserves argument boundaries and only receives explicit environment", () => {
  const plist = servicePlist(["/a path/Electron", "/b & <c>/background.cjs"], { CODEX_HOME: '/private/a "b"' }, "/private/logs");
  expect(plist).toContain("<string>/a path/Electron</string>");
  expect(plist).toContain("<string>/b &amp; &lt;c&gt;/background.cjs</string>");
  expect(plist).toContain("/private/a &quot;b&quot;");
  expect(plist).not.toContain("OPENAI_API_KEY");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
});

test("CLI wrapper preserves arguments and refuses unrelated files and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chat-wrapper-"));
  try {
    const target = join(root, "codex-chat");
    const script = join(root, "a ' quoted script.ts");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    installCliWrapper(target, process.execPath, script);
    installCliWrapper(target, process.execPath, script);
    const args = ["literal $(whoami)", "two words", "'quoted'"];
    const run = Bun.spawnSync([target, ...args]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual(args);
    writeFileSync(target, "unrelated command");
    expect(() => installCliWrapper(target, process.execPath, script)).toThrow("unrelated command");
    expect(readFileSync(target, "utf8")).toBe("unrelated command");
    rmSync(target); symlinkSync(script, target);
    const before = readFileSync(script, "utf8");
    expect(() => installCliWrapper(target, process.execPath, script)).toThrow("unrelated command");
    expect(readFileSync(script, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
