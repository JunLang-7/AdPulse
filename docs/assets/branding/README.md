# AdPulse Brand Assets — Alpha 02.3

Official working asset set based on the approved geometric asymmetric A + integrated pulse concept.

## Color palette
- Tech Blue: `#2563EB` (main A)
- Teal: `#14B8A6` (signal pulse)
- Dark Navy: `#111827` (wordmark)
- Dark canvas: `#0B1932`

## Contents
- `svg/icon-color.svg`: primary scalable symbol (transparent)
- `svg/icon-white.svg`, `svg/icon-navy.svg`: monochrome marks
- `svg/icon-on-dark.svg`, `svg/icon-on-light.svg`: square-background variants
- `svg/lockup-light.svg`: horizontal lockup for light backgrounds (transparent)
- `svg/lockup-dark.svg`: horizontal lockup for dark backgrounds (transparent)
- `svg/lockup-on-navy.svg`, `svg/lockup-on-white.svg`: canvas versions
- `png/icon/`: 16, 24, 32, 48, 64, 128, 256, 512, 1024 PNGs, where applicable
- `png/lockup/`: 470, 940, 1410 pixel-wide PNGs
- `web/`: favicon SVG/ICO and common web icons
- `web/README-snippet.md`: paste-ready GitHub README example

## Recommended usage
- GitHub README light background: `svg/lockup-light.svg`
- Dark UI: `svg/lockup-dark.svg`
- GitHub project/social avatar: `png/icon/icon-color-512.png` (place on chosen background if transparency is undesirable)
- Favicon: `web/favicon.ico` or `web/favicon.svg`
- Mobile icon: `web/favicon-180.png` or `web/favicon-192.png`

## Web HTML
```html
<link rel="icon" href="/branding/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/branding/favicon.ico" sizes="any" />
<link rel="apple-touch-icon" href="/branding/favicon-180.png" />
```

## Design QA
The primary mark is intentionally simple, but at 16–24px the pulse is very small. Those exports use a subtle stroke-weight adjustment (micro variant). For consistency, validate the icon at actual rendered pixel size against the target UI before shipping.

## Text portability
Wordmark SVGs contain an editable text element styled with `Inter, Arial, sans-serif`; exact glyph appearance depends on the recipient device/font availability. PNG exports are fixed. Use an installed Inter font (or outline the text) before sending to a print vendor.

These are vector reconstructions of the approved visual concept, not exact pixel-traced vectors of the AI-generated preview board.
