# The Lumbridge mark

Three blocks, one color. These SVGs are the sources: `node scripts/make-icons.mjs` renders every PNG in `web/public` from them (run `cd tests && npm i` first). The Tauri icons in `app/src-tauri/icons` are not committed: `scripts/build-android.sh` makes them from `web/public/icon-512.png` (`cargo tauri icon`), so a native rebuild picks the mark up.

- `icon.svg`: #fafafa on #0a0a0a, full bleed, the mark at 75% (iOS and Android round the tile). `icon-maskable.svg`: the mark at 62%, inside the 80% safe circle.
- `mark-mono.svg`: white on transparent, for monochrome icons, the notification badge, the splash and the pairing screen's CSS mask (`web/public/icon-mark.svg` is a copy).
- `favicon.svg`: the optically fitted 16 px favicon, integer blocks with a one-pixel gap (`web/public/icon-favicon.svg` is a copy).

The geometry is the canonical Lumbridge mark. The mark is Lumbridge's own: it is not covered by this repository's code licence, and it may not be used to suggest that another product is Lumbridge. One color only; the favicon's lime is the brand's one accent.
