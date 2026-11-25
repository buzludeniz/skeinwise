# Skeinwise brand files

The Skeinwise logo is one thread drawn as an S. The thread starts at a node, which stands for a point in the
record. It runs round the small upper bowl, crosses a straight spine, then winds into a coil, like thread wound on
a skein. The geometry is our own: two circle arcs joined by their common tangent, and a coil that tightens as it
turns. Nothing was traced.

## Files

| File | What it is for |
|---|---|
| `logo-mark.svg` | The mark on light grounds. 64 by 64 viewBox. |
| `logo-mark-dark.svg` | The mark on dark grounds. |
| `logo-lockup-light.svg` | Mark and word on light grounds. The top of the project README uses it. |
| `logo-lockup-dark.svg` | Mark and word on dark grounds. The README shows it when the reader's system is in dark mode. |
| `logo-mark-512.png`, `-256`, `-128`, `-64`, `-32`, `-16` | `logo-mark.svg` at that many pixels square, on a transparent background. For avatars, app icons and places that take no SVG. |
| `logo-lockup-light.png`, `logo-lockup-dark.png` | The lockups at 1200 px wide, on a transparent background. |
| `favicon.ico` | The browser tab icon, at 16, 32 and 48 px. It is the dark mark on a rounded Dusk tile, so it shows on light and dark tab bars. At 16 px the coil stops two curves early and the thread is a little heavier, so the S stays clear. |
| `social-preview.png` | 1280 by 640, the dark lockup centred on the Dusk ground. Upload it as the GitHub repository's social preview. |

## Colours

| Part | Light grounds | Dark grounds |
|---|---|---|
| Thread | `#9a4f17` (Linen accent) | `#e3a857` (Dusk accent) |
| Node and word | `#2a241c` (Linen ink) | `#e9e4d8` (Dusk ink) |
| Ground of the favicon tile and social preview | | `#0f1219` (Dusk ground) |

These are the app's own Linen and Dusk theme colours from `web/src/themes.ts`. The thread `#9a4f17` is 6.0:1 on
white and 5.1:1 on the Linen ground `#f2ede3`. The thread `#e3a857` is 8.9:1 on `#0f1219`. Keep the light files
on light grounds and the dark files on dark grounds: `#e3a857` is only 2.1:1 on white.

## Font

The word is set in STIX Two Text Medium (weight 500), at 41 units with 0.3 letter spacing, beside the 64-unit mark.
STIX Two Text is by the STIX Fonts Project and Tiro Typeworks, under the SIL Open Font License 1.1
(<https://scripts.sil.org/OFL>). The word is converted to outlines, so no file here needs the font, and the font
itself is not included.

## Using the files

- Leave clear space round the mark of at least the node's width on every side.
- The mark reads down to 16 px. Use the lockup at 120 px wide or more; below that, use the mark alone.
- Use the colour pairs above as they are. Do not stretch, rotate, outline or shadow the logo.
- The SVGs are plain paths: no text, no fonts, no embedded images and no editor data. The thread is one stroked
  path with round ends that starts at the node, and the node is one circle. To animate it, draw the path in from
  the node with `stroke-dasharray` and `stroke-dashoffset`, then fade in the node.

## Licence

These files are part of Skeinwise and are released under the MIT licence with the rest of the project. See
`LICENSE` at the root of the repository. The letter shapes of the word come from STIX Two Text, whose licence
allows this use.
