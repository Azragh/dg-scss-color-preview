# DG SCSS Color Preview

VS Code inline color previews for SCSS variables, CSS custom properties, and derived color tokens.

DG SCSS Color Preview is built for projects where colors are not only defined as direct literals, but also through SCSS variables, chained token systems, interpolation, and selected helper-based color patterns.

Instead of only previewing plain values such as `#2196f3` or `rgb(...)`, the extension follows references and resolves resulting colors where supported. This makes it especially useful in codebases with semantic color tokens, exported CSS variables, and derived palette systems.

## Why this extension is useful

Many color preview extensions work well for direct color values, but become far less useful once colors are defined indirectly through variables, helper functions, or exported token layers.

DG SCSS Color Preview focuses on that practical use case. It is designed to make variable-driven color systems easier to read at a glance by previewing resolved colors directly in the editor.

This includes support for custom SCSS helper patterns such as:

```scss
@function alpha($color, $alpha) {
  @return unquote("color-mix(in srgb, " + $color + " " + ($alpha * 100%) + ", transparent)");
}

@function tint($color, $percentage) {
  @return color.mix(white, $color, $percentage);
}

@function shade($color, $percentage) {
  @return color.mix(black, $color, $percentage);
}
```

## Example

![DG SCSS Color Preview example](https://raw.githubusercontent.com/azragh/dg-scss-color-preview/main/img/screenshot.png)

The screenshot above shows how the extension previews resolved colors directly in variable-based SCSS and CSS workflows.

## Features

- Inline underline-based color previews without adding extra spacing to the editor layout
- Resolves chained SCSS variable references and derived token values
- Resolves CSS custom properties such as `--primary-500` and related token exports
- Supports interpolation such as `#{$primary-500}`
- Supports selected derived color patterns, including:
  - `color.mix(...)`
  - `mix(...)`
  - custom `tint(...)`
  - custom `shade(...)`
  - custom `alpha(...)`
- Supports `var(--token)` references
- Supports direct color literals such as:
  - hex values
  - `rgb(...)`
  - `rgba(...)`
  - `hsl(...)`
  - `hsla(...)`
  - `oklab(...)`
  - `oklch(...)`
- Supports variable-based alpha patterns such as `rgba($token, 0.25)`
- Supports standard CSS color names such as `white`, `black`, `red`, `orange`, `green`, or `dodgerblue`
- Avoids duplicate decorations where a resolved token and a nested literal would otherwise overlap

## Best suited for

- SCSS design tokens
- semantic color systems
- derived palette scales
- custom color helper functions
- CSS custom properties
- token exports from SCSS to CSS variables

## Installation

The repository already includes a packaged `.vsix` file. You can install it via **Extensions → ... → Install from VSIX...**.

If you want to inspect, modify, or test the extension locally, open the project folder in VS Code and press `F5` to launch it in an Extension Development Host.

## Command

- `SCSS Color Preview: Refresh`

## Notes

DG SCSS Color Preview is intentionally focused on practical SCSS and CSS color workflows. It is not a full Sass compiler and does not attempt to evaluate every possible Sass function or arbitrary nested expression.

The extension is designed to handle direct color literals, variable references, CSS custom properties, interpolation, and selected helper-based token patterns commonly used in real-world projects.