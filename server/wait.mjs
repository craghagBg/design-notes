#!/usr/bin/env node
// Blocks until notes are submitted, prints them as JSON and exits - run in the background,
// its exit is what wakes Claude.
const port = Number(process.env.DESIGN_NOTES_PORT || 8787)

for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/wait`)
    if (res.status === 409) {
      console.log("design-notes: another wait took over - nothing to do here")
      process.exit(0)
    }
    if (res.status === 200) {
      console.log(await res.text())
      process.exit(0)
    }
    // 204: nothing yet, ask again
  } catch (error) {
    if (error.cause?.code !== "ECONNREFUSED") {
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    console.error(`design-notes: no server on port ${port} - run the server first`)
    process.exit(1)
  }
}
