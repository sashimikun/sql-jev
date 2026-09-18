# Site — sqljev.sharenow.today

Source of the live page. It is one self-contained HTML file plus two self-hosted variable fonts.

## Publish

```bash
./scripts/publish.sh /path/to/this/folder --slug sqljev --client <agent>
# from the sharenow skill directory:
#   bash scripts/publish.sh <folder> --slug sqljev --client <agent>
```

The first stdout line is the live URL. Republishing updates the same address; the helper purges the
edge cache, so a change is visible immediately.

## What is in here

- `index.html` — the whole page: inline CSS, inline SVG, one script block for copy buttons, the
  count-up counters and the scroll reveals. No framework, no build step.
- `fonts/SpaceGrotesk.woff2`, `fonts/JetBrainsMono.woff2` — the two typefaces, self-hosted so the page
  makes no third-party request at runtime. Both are SIL Open Font License 1.1; the licence texts sit
  next to them.

## Design language

The layout, palette, type scale, button geometry and motion timings follow the design language of
momentic.ai: warm ground `#f5f3f2`, olive-grey hairlines `#7f806f`, lime accent `#87f700`, near-black
pill buttons (radius `1.5rem`, asymmetric padding), heading metrics of `-0.04em` tracking at `1.08`
leading with a `6rem` ceiling, a `90rem` container, tinted stage sections, an odometer band and a
marquee strip.

Four differences are deliberate and are not defects:

1. **Content** — this is sql-jev, not Momentic.
2. **Typefaces** — Space Grotesk and JetBrains Mono stand in for the reference's proprietary
   BDO Grotesk and Basically A Mono, tuned to the same metrics. Both are free and self-hosted.
3. **Illustration** — hand-authored isometric SVG instead of Lottie animation, so the page has no
   runtime dependency and stays a single file.
4. **Self-containment** — no analytics, no CDN, no external CSS, no obfuscation.
