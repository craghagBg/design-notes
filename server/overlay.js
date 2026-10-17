// Design notes overlay. The bookmarklet loads it from the local design-notes server;
// loading it again while it is on turns it off.
(() => {
  if (window.__designNotes) {
    window.__designNotes.destroy()
    return
  }

  const SERVER = new URL(document.currentScript?.src || "http://localhost:8787/overlay.js").origin
  const KEY = "__designNotes"
  const MIN_GAP = 20
  const Z = 2147483647
  const COLOUR = { vertical: "255,0,170", inside: "255,140,0", horizontal: "0,200,255" }

  // ---------- storage (per site origin, in the site's localStorage)
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "[]")
    } catch {
      return []
    }
  }
  const save = (notes) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(notes))
    } catch {}
    refresh()
  }
  const pageOf = (win) => win.location.origin + win.location.pathname + win.location.search

  // ---------- describing elements so Claude can find them in the code
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null
    const cls = [...el.classList].slice(0, 10).join(".")
    const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60)
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls : ""}${text ? ` «${text}»` : ""}`
  }
  const selectorOf = (el) => {
    const parts = []
    for (let e = el; e && e.nodeType === 1 && e.tagName !== "HTML" && parts.length < 6; e = e.parentElement) {
      if (e.id) {
        parts.unshift("#" + CSS.escape(e.id))
        break
      }
      let part = e.tagName.toLowerCase()
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : []
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`
      parts.unshift(part)
    }
    return parts.join(" > ")
  }

  // ---------- empty bands: between siblings, and inside a box above/below its content
  const measureGaps = (win, skipEl) => {
    const doc = win.document
    const sx = win.scrollX
    const sy = win.scrollY
    const css = (el) => win.getComputedStyle(el)
    const visible = (el) => {
      const cs = css(el)
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false
      const r = el.getBoundingClientRect()
      return r.width > 2 && r.height > 2
    }
    const skip = (el) => el === skipEl || el.closest("script, style, dialog, svg, [aria-hidden=true]") || css(el).position === "fixed"
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return { l: r.left + sx, t: r.top + sy, r: r.right + sx, b: r.bottom + sy }
    }
    const bands = []
    const seen = new Set()
    const add = (kind, box, px, a, b) => {
      if (px < MIN_GAP) return
      const key = [kind, box.l, box.t, box.r, box.b].map((v) => (typeof v === "number" ? Math.round(v / 4) : v)).join(",")
      if (seen.has(key)) return
      seen.add(key)
      bands.push({ kind, box, px: Math.round(px), between: [describe(a), describe(b)].filter(Boolean) })
    }
    for (const parent of doc.body.querySelectorAll("*")) {
      if (skip(parent) || !visible(parent)) continue
      const kids = [...parent.children].filter((k) => !skip(k) && visible(k) && css(k).position !== "absolute")
      if (!kids.length) continue
      const p = rect(parent)
      const rs = kids.map(rect)
      const top = Math.min(...rs.map((r) => r.t))
      const bottom = Math.max(...rs.map((r) => r.b))
      const left = Math.min(...rs.map((r) => r.l))
      const right = Math.max(...rs.map((r) => r.r))
      // Only what padding and the child's margin create - not alignment filler (justify, min-height, stretch)
      const ps = css(parent)
      const first = kids[rs.findIndex((r) => r.t === top)]
      const last = kids[rs.findIndex((r) => r.b === bottom)]
      const padT = parseFloat(ps.paddingTop) + parseFloat(ps.borderTopWidth) + Math.max(0, parseFloat(css(first).marginTop))
      const padB = parseFloat(ps.paddingBottom) + parseFloat(ps.borderBottomWidth) + Math.max(0, parseFloat(css(last).marginBottom))
      const inT = Math.min(top - p.t, padT)
      const inB = Math.min(p.b - bottom, padB)
      add("inside", { l: left, r: right, t: top - inT, b: top }, inT, parent, null)
      add("inside", { l: left, r: right, t: bottom, b: bottom + inB }, inB, parent, null)
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = rs[i]
          const b = rs[j]
          const xOverlap = Math.min(a.r, b.r) - Math.max(a.l, b.l)
          const yOverlap = Math.min(a.b, b.b) - Math.max(a.t, b.t)
          if (xOverlap > 0 && b.t >= a.b - 1) {
            add("vertical", { l: Math.max(a.l, b.l), r: Math.min(a.r, b.r), t: a.b, b: b.t }, b.t - a.b, kids[i], kids[j])
            break
          }
          if (yOverlap > 0 && b.l >= a.r - 1) {
            if (b.l - a.r > 96) break // justify-between filler, not a gap anyone chose
            add("horizontal", { l: a.r, r: b.l, t: Math.max(a.t, b.t), b: Math.min(a.b, b.b) }, b.l - a.r, kids[i], kids[j])
            break
          }
        }
      }
    }
    return bands.sort((x, y) => x.box.t - y.box.t || x.box.l - y.box.l)
  }

  // ---------- one layer per document (the page and each same-origin iframe)
  const STYLE = `
    :host { all: initial }
    .band { position: absolute; pointer-events: none }
    .tag { position: absolute; transform: translate(-50%, -50%); color: #000; font: 700 12px/1 system-ui, sans-serif; padding: 3px 6px; border-radius: 9px; white-space: nowrap; cursor: pointer; pointer-events: auto }
    .pin { position: absolute; max-width: 260px; background: #fff59d; color: #111; font: 600 12px/1.35 system-ui, sans-serif; padding: 4px 7px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.45); pointer-events: none; white-space: pre-wrap }
    .card { background: #fff; color: #111; font: 13px/1.4 system-ui, sans-serif; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.45) }
    .editor { position: absolute; width: 300px; padding: 10px; pointer-events: auto }
    .editor b { display: block; margin-bottom: 6px }
    textarea { width: 100%; box-sizing: border-box; font: 14px system-ui, sans-serif; color: #111; background: #fff; border: 1px solid #999; border-radius: 6px; padding: 6px; resize: vertical }
    .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; flex-wrap: wrap }
    button { font: 600 12px system-ui, sans-serif; padding: 5px 9px; border-radius: 6px; border: 1px solid #bbb; background: #f4f4f4; color: #111; cursor: pointer }
    button.primary { background: #ff00aa; border-color: #ff00aa; color: #000 }
    button:disabled { opacity: .45; cursor: default }
    .panel { position: fixed; left: 12px; bottom: 12px; width: 340px; max-height: 45vh; display: flex; flex-direction: column; padding: 10px; pointer-events: auto }
    .panel header { display: flex; align-items: center; gap: 8px }
    .panel header span { flex: 1; color: #555 }
    .panel .row { justify-content: flex-start }
    .hint, .status { color: #555; margin-top: 6px }
    .status:empty { display: none }
    ul { list-style: none; margin: 6px 0 0; padding: 0; overflow: auto }
    li { display: flex; gap: 6px; align-items: flex-start; border-top: 1px solid #eee; padding: 4px 0 }
    li span { flex: 1; cursor: pointer; overflow-wrap: anywhere }
    li button { padding: 0 6px }
  `

  const frames = []
  let showGaps = true

  const mountLayer = (win, frameLabel) => {
    const doc = win.document
    const host = doc.createElement("design-notes-layer")
    host.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;z-index:${Z};pointer-events:none`
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>${STYLE}</style><div class="gaps"></div><div class="pins"></div><div class="ui"></div>`
    doc.documentElement.appendChild(host)
    const gapsEl = root.querySelector(".gaps")
    const pinsEl = root.querySelector(".pins")
    const uiEl = root.querySelector(".ui")
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag)
      if (cls) node.className = cls
      if (text != null) node.textContent = text
      return node
    }

    const openEditor = (x, y, label, details) => {
      uiEl.querySelector(".editor")?.remove()
      const box = el("div", "card editor")
      box.style.left = `${Math.max(win.scrollX + 8, Math.min(x, win.scrollX + win.innerWidth - 316))}px`
      box.style.top = `${y + 12}px`
      const area = el("textarea")
      area.rows = 3
      area.placeholder = "What should change here?"
      const cancel = el("button", "", "Cancel")
      const ok = el("button", "primary", "Save")
      const row = el("div", "row")
      row.append(cancel, ok)
      box.append(el("b", "", label), area, row)
      const close = () => box.remove()
      const commit = () => {
        const text = area.value.trim()
        if (text) {
          save([
            ...load(),
            {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              page: pageOf(window),
              frame: frameLabel,
              viewport: { width: win.innerWidth, height: win.innerHeight },
              x: Math.round(x),
              y: Math.round(y),
              text,
              at: new Date().toISOString(),
              ...details,
            },
          ])
        }
        close()
      }
      cancel.onclick = close
      ok.onclick = commit
      // Keys typed into the note must not reach the site's own shortcuts
      area.addEventListener("keydown", (e) => {
        e.stopPropagation()
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          commit()
        }
        if (e.key === "Escape") close()
      })
      area.addEventListener("keyup", (e) => e.stopPropagation())
      uiEl.appendChild(box)
      area.focus()
    }

    const drawGaps = () => {
      gapsEl.replaceChildren()
      if (!showGaps) return
      measureGaps(win, host).forEach((g, i) => {
        const n = i + 1
        const { l, t, r, b } = g.box
        const c = COLOUR[g.kind]
        const band = el("div", "band")
        band.style.cssText = `left:${l}px;top:${t}px;width:${r - l}px;height:${b - t}px;background:rgba(${c},.16);outline:1px dashed rgba(${c},.9)`
        const tag = el("div", "tag", `${n} · ${g.px}px`)
        tag.style.cssText = `left:${(l + r) / 2}px;top:${(t + b) / 2}px;background:rgb(${c})`
        tag.title = "Click to add a note about this gap"
        tag.onclick = (e) => {
          e.preventDefault()
          e.stopPropagation()
          openEditor(e.pageX, e.pageY, `Gap ${n} · ${g.px}px`, { gap: { n, px: g.px, kind: g.kind, between: g.between } })
        }
        gapsEl.append(band, tag)
      })
    }

    const drawPins = (notes) => {
      pinsEl.replaceChildren()
      for (const note of notes) {
        if (note.page !== pageOf(window) || note.frame !== frameLabel) continue
        const pin = el("div", "pin", `✎ ${note.text}`)
        pin.style.left = `${note.x}px`
        pin.style.top = `${note.y}px`
        pinsEl.appendChild(pin)
      }
    }

    // Alt + click anywhere: a note about that element (and no navigation / download)
    const onClick = (e) => {
      if (!e.altKey || e.composedPath().includes(host)) return
      e.preventDefault()
      e.stopPropagation()
      const target = e.target
      openEditor(e.pageX, e.pageY, "Note", {
        target: { selector: selectorOf(target), element: describe(target), parent: describe(target.parentElement) },
      })
    }
    win.addEventListener("click", onClick, true)

    return {
      win,
      host,
      uiEl,
      el,
      drawGaps,
      drawPins,
      destroy() {
        win.removeEventListener("click", onClick, true)
        host.remove()
      },
    }
  }

  // ---------- the panel (top window only)
  const top = mountLayer(window, null)
  const panel = top.el("div", "card panel")
  panel.innerHTML = `
    <header><b>Design notes</b><span class="count"></span><button class="close" title="Turn off">×</button></header>
    <div class="row">
      <button class="primary submit">Submit</button>
      <button class="copy">Copy</button>
      <button class="clear">Clear</button>
      <button class="toggle"></button>
      <button class="redraw" title="Measure again after scrolling, resizing or navigating">Redraw</button>
    </div>
    <div class="hint">Click a number, or Alt + click anything, to add a note.</div>
    <div class="status"></div>
    <ul></ul>`
  top.uiEl.appendChild(panel)
  const $ = (sel) => panel.querySelector(sel)
  const setStatus = (text) => ($(".status").textContent = text)

  const renderPanel = (notes) => {
    const here = notes.filter((n) => n.page === pageOf(window)).length
    $(".count").textContent = `${notes.length} total · ${here} on this page`
    $(".submit").disabled = $(".copy").disabled = $(".clear").disabled = !notes.length
    $(".toggle").textContent = showGaps ? "Hide gaps" : "Show gaps"
    $(".clear").textContent = "Clear"
    delete $(".clear").dataset.armed
    const list = $("ul")
    list.replaceChildren()
    notes.forEach((note) => {
      const item = top.el("li")
      const label = top.el("span", "", `${new URL(note.page).pathname}${note.frame ? " · iframe" : ""}${note.gap ? ` · gap ${note.gap.n}` : ""}: ${note.text}`)
      label.title = "Scroll to it"
      label.onclick = () => {
        if (note.page === pageOf(window) && !note.frame) window.scrollTo({ top: Math.max(0, note.y - 120), behavior: "smooth" })
      }
      const remove = top.el("button", "", "×")
      remove.title = "Delete"
      remove.onclick = () => save(load().filter((n) => n.id !== note.id))
      item.append(label, remove)
      list.appendChild(item)
    })
  }

  const asMarkdown = (notes) =>
    notes
      .map((n, i) => {
        const where = n.gap ? `gap ${n.gap.n} (${n.gap.px}px ${n.gap.kind}) between ${n.gap.between.join(" and ")}` : n.target?.element || ""
        return `${i + 1}. ${n.page}${n.frame ? ` (iframe ${n.frame})` : ""} @ ${n.viewport.width}px wide - ${where}${n.target ? `\n   selector: ${n.target.selector}` : ""}\n   > ${n.text}`
      })
      .join("\n")

  $(".close").onclick = () => api.destroy()
  $(".toggle").onclick = () => {
    showGaps = !showGaps
    redraw()
  }
  $(".redraw").onclick = () => redraw()
  // Two clicks instead of confirm(): a native dialog would block the page
  $(".clear").onclick = (e) => {
    const button = e.currentTarget
    if (button.dataset.armed) return save([])
    button.dataset.armed = "1"
    button.textContent = "Sure? Click again"
  }
  $(".copy").onclick = async () => {
    const text = asMarkdown(load())
    try {
      await navigator.clipboard.writeText(text)
      setStatus("Copied as text - paste it into Claude Code.")
    } catch {
      setStatus("Copy was blocked by the browser.")
    }
  }
  $(".submit").onclick = async () => {
    const notes = load()
    $(".submit").disabled = true
    setStatus("Sending…")
    try {
      const res = await fetch(`${SERVER}/notes`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(notes) })
      if (!res.ok) throw new Error(await res.text())
      const { waiting } = await res.json()
      const sent = new Set(notes.map((n) => n.id))
      save(load().filter((n) => !sent.has(n.id)))
      setStatus(waiting ? "Sent - Claude is on it." : "Sent. Claude picks them up as soon as /notes is waiting.")
    } catch (error) {
      $(".submit").disabled = false
      setStatus(
        String(error.message).includes("origin")
          ? "This site isn't allowed to submit. Add its origin to DESIGN_NOTES_ORIGINS, or use Copy."
          : "Couldn't reach Claude Code. Run /notes there, or use Copy."
      )
    }
  }

  // ---------- same-origin iframes get their own layer; cross-origin ones can't be reached
  const syncFrames = () => {
    for (const f of [...frames]) {
      if (!f.iframe.isConnected || f.iframe.contentWindow !== f.layer.win) {
        f.layer.destroy()
        frames.splice(frames.indexOf(f), 1)
      }
    }
    for (const iframe of document.querySelectorAll("iframe")) {
      if (frames.some((f) => f.iframe === iframe)) continue
      let win
      try {
        win = iframe.contentWindow
        if (!win?.document?.documentElement) continue
      } catch {
        continue
      }
      const label = iframe.getAttribute("src") || iframe.name || "iframe"
      frames.push({ iframe, layer: mountLayer(win, label) })
    }
  }

  const layers = () => [top, ...frames.map((f) => f.layer)]
  function refresh() {
    const notes = load()
    renderPanel(notes)
    layers().forEach((l) => l.drawPins(notes))
  }
  function redraw() {
    syncFrames()
    layers().forEach((l) => l.drawGaps())
    refresh()
  }

  // Re-measure after a resize and after client-side navigation
  let resizeTimer
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(redraw, 250)
  }
  window.addEventListener("resize", onResize)
  let lastPage = pageOf(window)
  const navTimer = setInterval(() => {
    if (pageOf(window) === lastPage) return
    lastPage = pageOf(window)
    setTimeout(redraw, 600)
  }, 500)

  const api = {
    destroy() {
      clearInterval(navTimer)
      clearTimeout(resizeTimer)
      window.removeEventListener("resize", onResize)
      layers().forEach((l) => l.destroy())
      delete window.__designNotes
    },
  }
  window.__designNotes = api
  redraw()
})()
