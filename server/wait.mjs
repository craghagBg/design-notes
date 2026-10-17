#!/usr/bin/env node
// Blocks until notes are submitted, prints them as JSON and exits - run in the background,
// its exit is what wakes Claude.
//   exit 0 + JSON          notes arrived
//   exit 0 + "took over"   a newer wait replaced this one
//   exit 1                 no server, or something unexpected answered
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "./server.mjs"

const port = Number(process.env.DESIGN_NOTES_PORT || 8787)
const fail = (message) => {
  console.error(`design-notes: ${message}`)
  process.exit(1)
}

for (;;) {
  let res
  try {
    // The server rewrites the token on every start, so read it each time
    const token = readFileSync(join(stateDir(port), "token"), "utf8")
    res = await fetch(`http://127.0.0.1:${port}/wait`, { headers: { "x-design-notes-token": token } })
  } catch (error) {
    if (error.code === "ENOENT" || error.cause?.code === "ECONNREFUSED") fail(`no server on port ${port} - start server.mjs first`)
    // A dropped connection: ask again in a moment
    await new Promise((r) => setTimeout(r, 1000))
    continue
  }
  if (res.status === 204) continue // nothing yet
  if (res.status === 200) {
    console.log(await res.text())
    process.exit(0)
  }
  if (res.status === 409) {
    console.log("design-notes: another wait took over")
    process.exit(0)
  }
  fail(`unexpected answer ${res.status} from port ${port}: ${(await res.text()).slice(0, 200)}`)
}
