// Design notes overlay. The bookmarklet loads it from the local design-notes server;
// loading it again while it is on turns it off.
(() => {
  if (window.__designNotes) {
    window.__designNotes.destroy()
    return
  }

  const SERVER = new URL(document.currentScript?.src || "http://localhost:8787/overlay.js").origin
  const COMMAND = "/design-notes:notes"
  const KEY = "__designNotes"
  const MIN_GAP = 20
  const Z = 2147483647
  const COLOUR = { vertical: "255,0,170", inside: "255,140,0", horizontal: "0,200,255" }
  const SKIP = "script, style, template, noscript, dialog, svg, [aria-hidden=true], design-notes-layer"

  let destroyed = false
  let showGaps = true

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
    } catch {
      setStatus("This page doesn't allow storing notes (storage is blocked) - use Copy before leaving.")
    }
    refresh(notes)
  }
  const pageOf = (win) => win.location.origin + win.location.pathname + win.location.search

  // ---------- describing elements so Claude can find them in the code
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null
    const cls = [...el.classList].slice(0, 10).join(".")
    // textContent: no layout, unlike innerText - matters on big containers
    const text = (el.getAttribute("aria-label") || el.textContent || "").slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 60)
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
  const measureGaps = (win) => {
    const doc = win.document
    if (!doc.body) return []
    const sx = win.scrollX
    const sy = win.scrollY
    // One style + box read per element, shared by its "parent" and "child" roles
    const cache = new Map()
    const info = (el) => {
      let i = cache.get(el)
      if (!i) {
        const cs = win.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        i = {
          cs,
          box: { l: r.left + sx, t: r.top + sy, r: r.right + sx, b: r.bottom + sy },
          shown: cs.visibility !== "hidden" && +cs.opacity !== 0 && r.width > 2 && r.height > 2,
        }
        cache.set(el, i)
      }
      return i
    }
    // Skip whole subtrees that can't have gaps worth drawing: hidden, fixed (would drift with the page), our own layer
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => {
        if (el.matches(SKIP)) return NodeFilter.FILTER_REJECT
        const { cs } = info(el)
        if (cs.display === "none" || cs.position === "fixed") return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })

    const bands = []
    const seen = new Set()
    const add = (kind, box, px, a, b) => {
      if (px < MIN_GAP) return
      const key = [kind, box.l, box.t, box.r, box.b].map((v) => (typeof v === "number" ? Math.round(v / 4) : v)).join(",")
      if (seen.has(key)) return
      seen.add(key)
      // The elements, not their descriptions: describing is only needed for the gap someone clicks
      bands.push({ kind, box, px: Math.round(px), a, b })
    }

    for (let parent = walker.nextNode(); parent; parent = walker.nextNode()) {
      if (!info(parent).shown) continue
      const kids = []
      for (const k of parent.children) {
        if (k.matches(SKIP)) continue
        const i = info(k)
        if (i.shown && i.cs.display !== "none" && i.cs.position !== "absolute" && i.cs.position !== "fixed") kids.push(k)
      }
      if (!kids.length) continue
      const p = info(parent).box
      const rs = kids.map((k) => info(k).box)
      let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity, first, last
      rs.forEach((r, i) => {
        if (r.t < top) (top = r.t), (first = kids[i])
        if (r.b > bottom) (bottom = r.b), (last = kids[i])
        left = Math.min(left, r.l)
        right = Math.max(right, r.r)
      })
      // Only what padding and the child's margin create - not alignment filler (justify, min-height, stretch)
      const ps = info(parent).cs
      const padT = parseFloat(ps.paddingTop) + parseFloat(ps.borderTopWidth) + Math.max(0, parseFloat(info(first).cs.marginTop))
      const padB = parseFloat(ps.paddingBottom) + parseFloat(ps.borderBottomWidth) + Math.max(0, parseFloat(info(last).cs.marginBottom))
      const inT = Math.min(top - p.t, padT)
      const inB = Math.min(p.b - bottom, padB)
      add("inside", { l: left, r: right, t: top - inT, b: top }, inT, parent, null)
      add("inside", { l: left, r: right, t: bottom, b: bottom + inB }, inB, parent, null)
      // The next sibling below or to the right; a bounded look-ahead keeps reversed/overlapping layouts from going quadratic
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < Math.min(kids.length, i + 40); j++) {
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

  // ---------- DOM helper (no innerHTML: pages with Trusted Types would refuse it)
  const make = (doc, tag, props = {}, children = []) => {
    const node = doc.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v
      else if (k === "text") node.textContent = v
      else if (k === "style") node.style.cssText = v
      else node[k] = v
    }
    node.append(...children)
    return node
  }

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

  // ---------- one layer per document (the page and each same-origin iframe)
  const mountLayer = (win, frameLabel) => {
    const doc = win.document
    const el = (tag, props, children) => make(doc, tag, props, children)
    const host = el("design-notes-layer", { style: `position:absolute;left:0;top:0;width:0;height:0;z-index:${Z};pointer-events:none` })
    const root = host.attachShadow({ mode: "open" })
    const gapsEl = el("div")
    const pinsEl = el("div")
    const uiEl = el("div")
    root.append(el("style", { text: STYLE }), gapsEl, pinsEl, uiEl)
    doc.documentElement.appendChild(host)
    const ours = (e) => e.composedPath().includes(host)

    const openEditor = (x, y, label, details) => {
      uiEl.querySelector(".editor")?.remove()
      const area = el("textarea", { rows: 3, placeholder: "What should change here?" })
      const cancel = el("button", { text: "Cancel" })
      const ok = el("button", { class: "primary", text: "Save" })
      const box = el("div", { class: "card editor" }, [el("b", { text: label }), area, el("div", { class: "row" }, [cancel, ok])])
      box.style.left = `${Math.max(win.scrollX + 8, Math.min(x, win.scrollX + win.innerWidth - 316))}px`
      box.style.top = `${y + 12}px`
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
      // Called from onKey: the event never reaches the textarea's own listeners (see onKey)
      area.dnKeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          commit()
        }
        if (e.key === "Escape") close()
      }
      uiEl.appendChild(box)
      area.focus()
    }

    const drawGaps = () => {
      gapsEl.replaceChildren()
      if (!showGaps) return
      measureGaps(win).forEach((g, i) => {
        const n = i + 1
        const { l, t, r, b } = g.box
        const c = COLOUR[g.kind]
        const tag = el("div", { class: "tag", text: `${n} · ${g.px}px`, title: "Click to add a note about this gap" })
        tag.style.cssText = `left:${(l + r) / 2}px;top:${(t + b) / 2}px;background:rgb(${c})`
        tag.onclick = (e) => {
          e.preventDefault()
          e.stopPropagation()
          const between = [describe(g.a), describe(g.b)].filter(Boolean)
          openEditor(e.pageX, e.pageY, `Gap ${n} · ${g.px}px`, { gap: { n, px: g.px, kind: g.kind, between } })
        }
        gapsEl.append(
          el("div", { class: "band", style: `left:${l}px;top:${t}px;width:${r - l}px;height:${b - t}px;background:rgba(${c},.16);outline:1px dashed rgba(${c},.9)` }),
          tag
        )
      })
    }

    const drawPins = (notes) => {
      pinsEl.replaceChildren(
        ...notes
          .filter((note) => note.page === pageOf(window) && note.frame === frameLabel)
          .map((note) => el("div", { class: "pin", text: `✎ ${note.text}`, style: `left:${note.x}px;top:${note.y}px` }))
      )
    }

    // Alt + click anywhere: a note about that element (and no navigation / download)
    const onClick = (e) => {
      if (!e.altKey || ours(e)) return
      e.preventDefault()
      e.stopPropagation()
      const target = e.target
      openEditor(e.pageX, e.pageY, "Note", {
        target: { selector: selectorOf(target), element: describe(target), parent: describe(target.parentElement) },
      })
    }
    // Typing a note must not trigger the site's own shortcuts (outside the shadow root the target looks like our
    // host, not a textarea). Stopping it here, first in line, also stops our own listeners - so Enter/Escape run here.
    const onKey = (e) => {
      if (!ours(e)) return
      if (e.type === "keydown") e.composedPath()[0].dnKeydown?.(e)
      e.stopImmediatePropagation()
    }
    // Scrolling an inner container moves the content under the bands - measure again when it settles
    const onScroll = (e) => {
      if (e.target !== doc && e.target !== doc.documentElement && !ours(e)) schedule(redraw, 200)
    }
    win.addEventListener("click", onClick, true)
    for (const type of ["keydown", "keyup", "keypress"]) win.addEventListener(type, onKey, true)
    win.addEventListener("scroll", onScroll, true)

    return {
      doc,
      el,
      uiEl,
      drawGaps,
      drawPins,
      destroy() {
        win.removeEventListener("click", onClick, true)
        for (const type of ["keydown", "keyup", "keypress"]) win.removeEventListener(type, onKey, true)
        win.removeEventListener("scroll", onScroll, true)
        host.remove()
      },
    }
  }

  // ---------- the panel (top window only)
  const top = mountLayer(window, null)
  const button = (cls, text, title) => top.el("button", { class: cls, text, ...(title ? { title } : {}) })
  const ui = {
    count: top.el("span"),
    close: button("", "×", "Turn off"),
    submit: button("primary", "Submit"),
    copy: button("", "Copy"),
    clear: button("", "Clear"),
    toggle: button(""),
    redraw: button("", "Redraw", "Measure again after scrolling, resizing or navigating"),
    status: top.el("div", { class: "status" }),
    list: top.el("ul"),
  }
  top.uiEl.appendChild(
    top.el("div", { class: "card panel" }, [
      top.el("header", {}, [top.el("b", { text: "Design notes" }), ui.count, ui.close]),
      top.el("div", { class: "row" }, [ui.submit, ui.copy, ui.clear, ui.toggle, ui.redraw]),
      top.el("div", { class: "hint", text: "Click a number, or Alt + click anything, to add a note." }),
      ui.status,
      ui.list,
    ])
  )
  function setStatus(text) {
    ui.status.textContent = text
  }

  const renderPanel = (notes) => {
    const here = notes.filter((n) => n.page === pageOf(window)).length
    ui.count.textContent = `${notes.length} total · ${here} on this page`
    ui.submit.disabled = ui.copy.disabled = ui.clear.disabled = !notes.length
    ui.toggle.textContent = showGaps ? "Hide gaps" : "Show gaps"
    ui.clear.textContent = "Clear"
    delete ui.clear.dataset.armed
    ui.list.replaceChildren(
      ...notes.map((note) => {
        const label = top.el("span", {
          text: `${new URL(note.page).pathname}${note.frame ? " · iframe" : ""}${note.gap ? ` · gap ${note.gap.n}` : ""}: ${note.text}`,
          title: "Scroll to it",
        })
        label.onclick = () => {
          if (note.page === pageOf(window) && !note.frame) window.scrollTo({ top: Math.max(0, note.y - 120), behavior: "smooth" })
        }
        const remove = button("", "×", "Delete")
        remove.onclick = () => save(load().filter((n) => n.id !== note.id))
        return top.el("li", {}, [label, remove])
      })
    )
  }

  const asMarkdown = (notes) =>
    notes
      .map((n, i) => {
        const where = n.gap ? `gap ${n.gap.n} (${n.gap.px}px ${n.gap.kind}) between ${n.gap.between.join(" and ")}` : n.target?.element || ""
        return `${i + 1}. ${n.page}${n.frame ? ` (iframe ${n.frame})` : ""} @ ${n.viewport.width}px wide - ${where}${n.target ? `\n   selector: ${n.target.selector}` : ""}\n   > ${n.text}`
      })
      .join("\n")

  // navigator.clipboard needs https or localhost; plain-http dev hosts (*.test) get the old way
  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
    const area = top.el("textarea", { value: text, style: "position:fixed;opacity:0" })
    top.uiEl.appendChild(area)
    area.select()
    const ok = top.doc.execCommand("copy")
    area.remove()
    if (!ok) throw new Error("copy refused")
  }

  ui.close.onclick = () => api.destroy()
  ui.toggle.onclick = () => {
    showGaps = !showGaps
    redraw()
  }
  ui.redraw.onclick = () => redraw()
  // Two clicks instead of confirm(): a native dialog would block the page
  ui.clear.onclick = () => {
    if (ui.clear.dataset.armed) return save([])
    ui.clear.dataset.armed = "1"
    ui.clear.textContent = "Sure? Click again"
  }
  ui.copy.onclick = async () => {
    try {
      await copyText(asMarkdown(load()))
      setStatus("Copied as text - paste it into Claude Code.")
    } catch {
      setStatus("The browser blocked copying.")
    }
  }
  ui.submit.onclick = async () => {
    const notes = load()
    ui.submit.disabled = true
    setStatus("Sending…")
    let res
    try {
      res = await fetch(`${SERVER}/notes`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(notes) })
    } catch {
      ui.submit.disabled = false
      return setStatus(`Couldn't reach Claude Code. Run ${COMMAND} there (or the page's security policy blocks it - then use Copy).`)
    }
    if (!res.ok) {
      ui.submit.disabled = false
      const reason = await res.text()
      return setStatus(
        reason.includes("origin")
          ? "This site isn't allowed to submit. Add its origin to DESIGN_NOTES_ORIGINS, or use Copy."
          : `Claude Code refused the notes (${reason}). Use Copy instead.`
      )
    }
    const { waiting } = await res.json()
    const sent = new Set(notes.map((n) => n.id))
    save(load().filter((n) => !sent.has(n.id)))
    setStatus(waiting ? "Sent - Claude is on it." : `Sent. Claude picks them up as soon as ${COMMAND} is waiting.`)
  }

  // ---------- same-origin iframes get their own layer; cross-origin ones can't be reached
  let frames = []
  const syncFrames = () => {
    frames = frames.filter((f) => {
      let current = null
      try {
        current = f.iframe.isConnected ? f.iframe.contentDocument : null
      } catch {}
      // Gone, or navigated to a new document: drop the old layer (a fresh one is mounted below)
      if (current === f.layer.doc) return true
      try {
        f.layer.destroy()
      } catch {}
      return false
    })
    document.querySelectorAll("iframe").forEach((iframe, index) => {
      if (frames.some((f) => f.iframe === iframe)) return
      let win
      try {
        win = iframe.contentWindow
        if (!win?.document?.body) return
      } catch {
        return // cross-origin
      }
      frames.push({ iframe, layer: mountLayer(win, `#${index + 1} ${win.location.href}`) })
    })
  }

  const layers = () => [top, ...frames.map((f) => f.layer)]
  // A layer whose iframe went away mid-draw must not stop the others
  const eachLayer = (fn) =>
    layers().forEach((layer) => {
      try {
        fn(layer)
      } catch {}
    })
  function refresh(notes = load()) {
    renderPanel(notes)
    eachLayer((l) => l.drawPins(notes))
  }
  function redraw() {
    if (destroyed) return
    syncFrames()
    eachLayer((l) => l.drawGaps())
    refresh()
  }

  // One timer for every "measure again later": resize, inner scroll, client-side navigation
  let timer
  function schedule(fn, ms) {
    clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
  const onResize = () => schedule(redraw, 250)
  window.addEventListener("resize", onResize)
  let lastPage = pageOf(window)
  const navTimer = setInterval(() => {
    if (pageOf(window) === lastPage) return
    lastPage = pageOf(window)
    schedule(redraw, 600)
  }, 500)

  const api = {
    destroy() {
      destroyed = true
      clearInterval(navTimer)
      clearTimeout(timer)
      window.removeEventListener("resize", onResize)
      eachLayer((l) => l.destroy())
      delete window.__designNotes
    },
  }
  window.__designNotes = api
  redraw()
})()
