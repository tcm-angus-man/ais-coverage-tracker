# Design system

Match the existing CoverageGrid. Don't introduce new fonts, decorative accents, or nautical theming.

## Colors (Tailwind classes, with rgba where the canvas uses them)

| Surface | Class / value |
|---|---|
| Page ground | `bg-neutral-950` (`#0a0a0a`) |
| Panels, headers | `bg-neutral-900` |
| Recessed surfaces, row striping | `bg-neutral-800` / `#111` / `#171717` |
| Borders | `border-neutral-800` (most), `border-neutral-700` (controls) |
| Primary text | `text-neutral-100` |
| Secondary text | `text-neutral-400` |
| Tertiary text | `text-neutral-500` |
| Active state / primary action | `bg-emerald-700 text-white` |
| Hover on interactive | `hover:bg-neutral-800` |
| Cleaned / positive data | `rgba(16,185,129,a)` (emerald) |
| Backlog / warning data | `rgba(245,158,11,a)` (amber) |
| Orphan / informational data | `rgba(59,130,246,a)` (blue) |
| Silver-mode data | `rgba(20,184,166,a)` (teal) |
| Errors | `text-red-400` |

Density alpha: `min(1, 0.2 + t/14)` — saturates at `t = 14`.

## Typography

`ui-sans-serif, system-ui, sans-serif`. No serifs.

| Use | Size |
|---|---|
| Canvas labels | 11px |
| UI body | 12–14px |
| Section headers | 16–18px |

`tabular-nums` on every number. Always.

## Density

- Cells: 8px wide × 14px tall
- Headers: 36px tall
- Controls bar: `py-2 px-3`
- Modal padding: `p-4`

The app is information-dense by design.

## Cell encoding (combined mode)

| Condition | Color |
|---|---|
| voyage ∩ silver | emerald (cleaned) |
| voyage only | amber (backlog) |
| silver only | blue (orphan silver) |

`ratio` mode: HSL red → amber → green by `v/t`.
