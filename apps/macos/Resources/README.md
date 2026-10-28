`KarakeepStatus.svg` contains the two glyph contours from the official mark in
`apps/web/public/icons/logo-icon.svg`. The filled square is removed and the
previously transparent glyph is solid, reversing the original foreground and
background. The view box is cropped to the glyph.

`KarakeepStatus.pdf` is the menu bar's vector template image. macOS supplies the
correct color in light, dark, and selected states.

To regenerate it from the repository root with librsvg installed:

```sh
rsvg-convert --format pdf --width 18 --height 18 \
  --output apps/macos/Resources/KarakeepStatus.pdf \
  apps/macos/Resources/KarakeepStatus.svg
```
