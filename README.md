<div align="center">

<img src="https://raw.githubusercontent.com/azragh/dg-scss-color-preview/main/img/thumbnail.png" width="96" alt="DG SCSS Color Preview logo">

# DG SCSS Color Preview

**Inline color previews for SCSS variables, CSS custom properties and derived color tokens.**

</div>

> **Personal project, provided as-is.** Feel free to use, clone or fork it. Issues and pull requests are welcome, but there is no guaranteed support and they may not be looked at regularly.

![DG SCSS Color Preview example](https://raw.githubusercontent.com/azragh/dg-scss-color-preview/main/img/screenshot.png)

## Why this extension?

Most color preview extensions work well for direct values like `#2196f3` or `rgb(...)`, but become far less useful once colors are defined **indirectly**, through variables, helper functions or exported token layers.

DG SCSS Color Preview follows those references and resolves the resulting color, so variable-driven color systems become readable at a glance:

```scss
$cbase1:      #2196f3;             // blue
$primary-700: shade($cbase1, 40%); // resolved dark blue
$header_bg:   $primary-700;        // follows the chain
--header-bg:  #{$header_bg};       // CSS variables too
```

**Best suited for** SCSS design tokens · CSS custom properties · semantic color systems · derived palette scales

## Features

### Previews

- Underline-based previews, **no extra spacing** added to the editor layout
- Duplicate decorations are avoided where a resolved token and a nested literal would overlap

### Resolving

- Chained SCSS variable references and derived token values
- CSS custom properties such as `--primary-500`, including `var(--token)` references
- Interpolation such as `#{$primary-500}`
- Commented-out declarations are used as a **fallback**, so preview-only demo blocks can stay commented out

### Supported color functions

| Type | Supported |
| --- | --- |
| Mixing & helpers | `color.mix(...)`, `mix(...)`, custom `tint(...)`, `shade(...)`, `alpha(...)` |
| Alpha patterns | `rgba($token, 0.25)` |
| Color schemes | `light-dark(...)`, see [below](#light-dark) |
| Literals | hex, `rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`, `oklab(...)`, `oklch(...)` |
| Named colors | `white`, `black`, `red`, `orange`, `green`, `dodgerblue`, … |

The custom helpers are expected to look like this:

```scss
@function alpha($color, $alpha) {
  @return string.unquote("color-mix(in srgb, #{$color} #{($alpha * 100%)}, transparent)");
}

@function tint($color, $percentage) {
  @return color.mix(white, $color, $percentage);
}

@function shade($color, $percentage) {
  @return color.mix(black, $color, $percentage);
}
```

### light-dark()

Colors defined with `light-dark(...)`, and everything derived from them, show **both** values: the first characters of the underline show the light value, the rest the dark value. With `scssColorPreview.hover` enabled, hovering a variable shows both colors.

### Lightweight indexing

- Files are read directly instead of being opened as editor documents
- WordPress core / plugins, `node_modules`, `vendor` and build folders are skipped
- Variables from files closest to the current document take precedence

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `scssColorPreview.enabled` | `true` | Enable or disable all previews |
| `scssColorPreview.lightDark` | `both` | How `light-dark()` is previewed: `both`, `light` or `dark` |
| `scssColorPreview.lightDarkLeadChars` | `5` | Number of characters that show the light value |
| `scssColorPreview.hover` | `false` | Show a hover tooltip with the resolved color value |
| `scssColorPreview.contrastOutline` | `false` | Subtle outline for colors that blend into the editor background (e.g. near-black on a dark theme) |
| `scssColorPreview.exclude` | `[]` | Additional glob patterns to skip when indexing |
| `scssColorPreview.maxFiles` | `300` | Maximum number of style files to index |

**Command:** `SCSS Color Preview: Refresh`

## Installation

The repository includes a packaged `.vsix` file. Install it via **Extensions → `···` → Install from VSIX...**

To inspect, modify or test the extension locally, open the project folder in VS Code and press `F5` to launch an Extension Development Host.

## Planned features

- `color.scale(...)`
- `color.adjust(...)`
- `color.change(...)`

## Notes

DG SCSS Color Preview is intentionally focused on practical SCSS and CSS color workflows. It is **not a full Sass compiler** and does not attempt to evaluate every possible Sass function or arbitrary nested expression.

It is designed to handle direct color literals, variable references, CSS custom properties, interpolation and selected helper-based token patterns commonly used in real-world projects.
