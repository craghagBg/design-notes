#!/usr/bin/env node
// Local bridge between the browser overlay and a Claude Code session.
//   GET  /            install page with the bookmarklet
//   GET  /overlay.js  the overlay the bookmarklet loads
//   POST /notes       the overlay submits notes (only from allowed origins)
//   GET  /wait        resolves with the pending notes; blocks until there are some
//   GET  /health      identifies this server
import { createServer } from "node:http"
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 2_000_000
const WAIT_MS = 4 * 60 * 1000

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
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  )
}

export function startServer({ port = 8787, host = "127.0.0.1", extraOrigins = [], spool } = {}) {
  spool ??= join(tmpdir(), `design-notes-${port}.json`)
  // Notes survive a server restart until a waiter has taken them
  let pending = existsSync(spool) ? JSON.parse(readFileSync(spool, "utf8")) : []
  let waiter = null

  const persist = () => (pending.length ? writeFileSync(spool, JSON.stringify(pending)) : existsSync(spool) && unlinkSync(spool))
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
  const file = (name, type) => (res) =>
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(readFileSync(join(here, name)))

  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname
    if (req.method === "OPTIONS") {
      return res.writeHead(204, { ...cors(req), "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true" }).end()
    }
    if (req.method === "GET" && path === "/") return file("install.html", "text/html; charset=utf-8")(res)
    if (req.method === "GET" && path === "/overlay.js") return file("overlay.js", "text/javascript; charset=utf-8")(res)
    if (req.method === "GET" && path === "/health") {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ app: "design-notes", pending: pending.length }))
    }
    if (req.method === "GET" && path === "/wait") {
      // One waiter at a time: a newer one (a restarted wait) replaces the old
      if (waiter) waiter.writeHead(409).end("replaced by a newer waiter")
      waiter = res
      // Node's fetch gives up on headers after 5 minutes - answer "nothing yet" before that, wait.mjs asks again
      const idle = setTimeout(() => waiter === res && ((waiter = null), res.writeHead(204).end()), WAIT_MS)
      res.on("close", () => {
        clearTimeout(idle)
        if (waiter === res) waiter = null
      })
      return deliver()
    }
    if (req.method === "POST" && path === "/notes") {
      // Any web page can send a simple POST to localhost - only local dev sites (and listed origins) may submit
      if (!originAllowed(req.headers.origin, extraOrigins)) {
        return res.writeHead(403, { "content-type": "text/plain" }).end("origin not allowed")
      }
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
        if (body.length > MAX_BODY) req.destroy()
      })
      req.on("end", () => {
        let notes
        try {
          notes = JSON.parse(body)
        } catch {
          return res.writeHead(400, cors(req)).end("bad json")
        }
        if (!Array.isArray(notes) || !notes.length) return res.writeHead(400, cors(req)).end("no notes")
        pending.push(...notes.map((n) => ({ ...n, origin: req.headers.origin })))
        persist()
        res.writeHead(200, { ...cors(req), "content-type": "application/json" }).end(JSON.stringify({ ok: true, count: notes.length, waiting: Boolean(waiter) }))
        deliver()
      })
      return
    }
    res.writeHead(404).end()
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
