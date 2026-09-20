#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
bun_bin=${BUN:-$(command -v bun)}
case "$bun_bin" in /*) ;; *) bun_bin=$(command -v "$bun_bin");; esac
if [ "$("$bun_bin" --version)" != "1.4.0" ]; then
  echo 'Bun 1.4.0 is required. Set BUN=/absolute/path/to/bun to use a separate installation.' >&2
  exit 1
fi
cd "$root"
"$bun_bin" install --frozen-lockfile --ignore-scripts
(cd launcher && "$bun_bin" install --frozen-lockfile)
# The installer refuses unrelated commands and symlinks at this path.
"$bun_bin" -e '
import { installCliWrapper } from "./src/chat-cli";
import { join } from "node:path";
import { homedir } from "node:os";
const target = join(homedir(), ".local", "bin", "codex-chat");
installCliWrapper(target, process.execPath, join(process.cwd(), "src", "chat-cli.ts"));
console.log(target);
'
exec "$bun_bin" "$root/src/chat-cli.ts" install "$@"
