# Protocol Explorer — Persian (fa)

Persian-localized build of Protocol Explorer (author: Dilum Sanjaya),
deployed as a static sub-app of this blog at
`/ahura-dev/protocol-explorer-fa/`.

- **Source of truth:** the standalone build in the localization project
  (`protocol-explorer-fa/` + `persian-localization/` reports). This copy is
  identical except for path adaptation (below).
- **What it is:** the deployed app localized through its own i18n system —
  a `fa` dictionary chunk (`assets/fa-*.js`, 3,879 strings, 50 patterns),
  registered in the language list, Persian default, RTL + self-hosted
  Vazirmatn. Dataset and simulation logic are byte-identical to the original.
- **Path adaptation for the blog subpath:** the original build uses
  root-relative URLs (`/assets/…`). Under `/ahura-dev/protocol-explorer-fa/`
  those would resolve to the site root, so all asset references in
  `index.html`, `assets/index-*.css` and `site.webmanifest` were rewritten
  to relative paths. Canonical/OG URLs point at the deployed blog URL.
  The JS bundle needed no change (it already loads chunks relatively).
- **Deploy:** committed under `public/`; Astro copies it verbatim to `dist/`
  and the GitHub Pages workflow deploys it. No build step touches these files.

- **Bundle patch (blog copy only):** Vite bakes the site root (`/`) into its
  chunk-preload helper (`Jm=function(e){return"/"+e}`), which makes language
  chunks preload from the site root — 404 under `/ahura-dev/…`. Here `Jm`
  resolves each chunk relative to the bundle itself
  (`new URL("../"+e, import.meta.url)`), so preloading works at any subpath.
  The actual `import("./fa-….js")` was already relative and unaffected.
