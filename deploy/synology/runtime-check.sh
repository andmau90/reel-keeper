#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$REELKEEPER_INSTALL_DIR/apps/server"
"$NODE_BIN" --input-type=module -e '
  import Database from "better-sqlite3";

  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 22) {
    throw new Error(`Expected Node.js 22, found ${process.versions.node}.`);
  }
  if (process.arch !== "arm64") {
    throw new Error(`Expected ARM64 Node.js, found ${process.arch}.`);
  }
  const database = new Database(":memory:");
  database.prepare("SELECT 1 AS ready").get();
  database.close();
  console.log(`Node.js ${process.versions.node} (${process.arch}) and better-sqlite3 are ready.`);
'
