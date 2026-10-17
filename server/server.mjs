#!/usr/bin/env node
// Local bridge between the browser overlay and a Claude Code session.
//   GET  /            install page with the bookmarklet
//   GET  /overlay.js  the overlay the bookmarklet loads
//   POST /notes       the overlay submits notes (only from allowed origins)
//   GET  /wait        resolves with the pending notes; blocks until there are some (wait.mjs only: needs the token)
//   GET  /health      identifies this server
import { createServer } from "node:http"
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 2_000_000
const MAX_NOTES = 500
const WAIT_MS = 4 * 60 * 1000

// Per-user, not the shared temp dir: other users can't plant notes or read them
export const stateDir = (port) => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "design-notes", String(port))

// Local development hosts, plus whatever DESIGN_NOTES_ORIGINS lists (comma separated, exact origins).
export function originAllowed(origin, extra = []) {
  if (!origin) return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (extra.includes(url.origin)) return true
  const host = url.hostname
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".test")
}

// A note is the user's text plus where it was made; anything else is dropped
const validNote = (n) => n && typeof n === "object" && !Array.isArray(n) && typeof n.text === "string" && n.text.trim() !== ""

export function startServer({ port = 8787, host = "127.0.0.1", extraOrigins = [], dir, waitMs = WAIT_MS } = {}) {
  dir ??= stateDir(port)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const spool = join(dir, "pending.json")
  const tokenFile = join(dir, "token")
  const token = randomBytes(24).toString("hex")
  writeFileSync(tokenFile, token, { mode: 0o600 })

  // Notes survive a server restart until a waiter has taken them; a broken spool is moved aside, not fatal
  let pending = []
  if (existsSync(spool)) {
    try {
      const saved = JSON.parse(readFileSync(spool, "utf8"))
      pending = Array.isArray(saved) ? saved.filter(validNote) : []
    } catch {
      renameSync(spool, `${spool}.broken-${Date.now()}`)
    }
  }
  let waiter = null

  const persist = () => {
    if (!pending.length) return rmSync(spool, { force: true })
    const tmp = `${spool}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(pending), { mode: 0o600 })
    renameSync(tmp, spool)
  }
  const deliver = () => {
    if (!waiter || !pending.length) return
    const res = waiter
    waiter = null
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pending, null, 1))
    pending = []
    persist()
  }
  const cors = (req) => {
    const origin = req.headers.origin
    return originAllowed(origin, extraOrigins) ? { "access-control-allow-origin": origin, vary: "origin" } : {}
  }
  // Only these names reach us legitimately; anything else is DNS rebinding
  const hostAllowed = (value, actualPort) => ["127.0.0.1", "localhost", "[::1]"].some((h) => value === `${h}:${actualPort}`)
  const tokenMatches = (value) => typeof value === "string" && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token))
  const send = (res, status, headers, body = "") => res.writeHead(status, headers).end(body)
  const file = (res, name, type) => send(res, 200, { "content-type": type, "cache-control": "no-store" }, readFileSync(join(here, name)))

  const handle = (req, res) => {
    const path = (req.url || "/").split("?")[0]
    if (!hostAllowed(req.headers.host, server.address().port)) return send(res, 421, { "content-type": "text/plain" }, "wrong host")
    if (req.method === "OPTIONS") {
      return send(res, 204, { ...cors(req), "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true" })
    }
    if (req.method === "GET" && path === "/") return file(res, "install.html", "text/html; charset=utf-8")
    if (req.method === "GET" && path === "/overlay.js") return file(res, "overlay.js", "text/javascript; charset=utf-8")
    if (req.method === "GET" && path === "/health") return send(res, 200, { "content-type": "application/json" }, JSON.stringify({ app: "design-notes" }))
    if (req.method === "GET" && path === "/wait") {
      // Only wait.mjs (it reads the token file) may take notes - a web page could otherwise swallow them
      if (!tokenMatches(req.headers["x-design-notes-token"])) return send(res, 403, { "content-type": "text/plain" }, "bad token")
      // One waiter at a time: a newer one (a restarted wait) replaces the old
      if (waiter) send(waiter, 409, { "content-type": "text/plain" }, "replaced by a newer waiter")
      waiter = res
      // Node's fetch gives up on headers after 5 minutes - answer "nothing yet" before that, wait.mjs asks again
      const idle = setTimeout(() => waiter === res && ((waiter = null), send(res, 204, {})), waitMs)
      res.on("close", () => {
        clearTimeout(idle)
        if (waiter === res) waiter = null
      })
      return deliver()
    }
    if (req.method === "POST" && path === "/notes") {
      // Any web page can send a simple POST to localhost - only local dev sites (and listed origins) may submit.
      // The refusal is readable cross-origin so the overlay can say why.
      if (!originAllowed(req.headers.origin, extraOrigins)) {
        return send(res, 403, { "content-type": "text/plain", "access-control-allow-origin": "*" }, "origin not allowed")
      }
      req.setEncoding("utf8")
      let body = ""
      let tooBig = false
      req.on("data", (chunk) => {
        if (tooBig) return
        body += chunk
        if (Buffer.byteLength(body) > MAX_BODY) {
          tooBig = true
          send(res, 413, cors(req), "too large")
          req.destroy()
        }
      })
      req.on("end", () => {
        if (tooBig) return
        let notes
        try {
          notes = JSON.parse(body)
        } catch {
          return send(res, 400, cors(req), "bad json")
        }
        if (!Array.isArray(notes)) return send(res, 400, cors(req), "expected a list of notes")
        notes = notes.filter(validNote).slice(0, MAX_NOTES)
        if (!notes.length) return send(res, 400, cors(req), "no notes")
        pending.push(...notes.map((n) => ({ ...n, origin: req.headers.origin })))
        persist()
        send(res, 200, { ...cors(req), "content-type": "application/json" }, JSON.stringify({ ok: true, count: notes.length, waiting: Boolean(waiter) }))
        deliver()
      })
      return
    }
    send(res, 404, {})
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res)
    } catch (error) {
      console.error("design-notes:", error)
      if (!res.headersSent) send(res, 500, {})
    }
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve(server))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DESIGN_NOTES_PORT || 8787)
  const extraOrigins = (process.env.DESIGN_NOTES_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
  try {
    await startServer({ port, extraOrigins })
    console.log(`design-notes: listening on http://localhost:${port} (install page: http://localhost:${port}/)`)
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null)
    if (health?.app === "design-notes") {
      console.log(`design-notes: already running on http://localhost:${port}`)
      process.exit(0)
    }
    console.error(`design-notes: port ${port} is taken by something else - set DESIGN_NOTES_PORT`)
    process.exit(1)
  }
}
