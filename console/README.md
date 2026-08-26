# Consola Karolito

A published Claude Artifact that reads the live **Planes Karolito** sheet, shows
the exact WhatsApp message the bot would send, and hands over the command to
send it.

<https://claude.ai/code/artifact/09641644-0da8-4789-885f-a35c7e5bbebe>

`planes-console.html` is the source. Editing it and republishing to the same URL
updates the page in place.

## What it can and cannot do

It **cannot send.** A published artifact runs under a strict CSP with no network
access to anything but Google Fonts and the viewer's own claude.ai connectors —
there is no route from the page to the VPS, and no GitHub connector to dispatch
the `vps.yml` workflow with either. So the console composes and prepares; the
send happens on the VPS.

What it does do:

- **Reads the live sheet** through the viewer's Google Drive connector, so it
  shows today's rows rather than `fixtures/planning.json`.
- **Previews the real message**, including the day grouping, the vote marks and
  the 3500-character split into numbered parts.
- **Curates**: exclude plans, or switch between this weekend and everything,
  and watch the message change.
- **Exports `planning.json`** in exactly the shape `src/planning/index.js`
  reads — live sheet data straight into the repo's fixture.
- **Generates the `.env` and the command** for the recipients and transport
  you pick.

## The preview must not drift

The page re-implements `src/format.js` in the browser. `tests/console.test.js`
extracts the page's real script, runs it under a DOM stub, and diffs its output
against the app's formatter — the preview is asserted byte-for-byte identical,
including pagination. Change `src/format.js` without changing the console and
those tests fail.

## Capabilities it declares

| Capability | Why |
| --- | --- |
| `mcp` → Google Drive, `read_file_content` | Reading the sheet with the viewer's own credentials |
| `downloads` | Saving `planning.json` |

The `mcp` grant is viewer-consented and bars public sharing, which is correct
here — the sheet is private.
