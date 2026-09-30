# Regenerates the toolbar icon PNGs as a monochrome dark badge with a white
# "A" mark — matches the popup's own .logo badge (background #1a1a1a,
# border #262626, white text) so the toolbar icon and the popup use the same
# visual language instead of the old teal/blue gradient mark.
Add-Type -AssemblyName System.Drawing

$bg     = [System.Drawing.Color]::FromArgb(255, 0x1A, 0x1A, 0x1A)
$border = [System.Drawing.Color]::FromArgb(255, 0x3A, 0x3A, 0x3A)
$fg     = [System.Drawing.Color]::White

function New-RoundedRectPath {
  param([single]$x, [single]$y, [single]$w, [single]$h, [single]$r)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconPng {
  param([int]$size, [string]$outPath)

  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $radius = [Math]::Max(2, $size * 0.22)
  $strokeW = [Math]::Max(1, $size * 0.06)
  $inset = $strokeW / 2

  $path = New-RoundedRectPath -x $inset -y $inset -w ($size - $strokeW) -h ($size - $strokeW) -r $radius
  $fillBrush = New-Object System.Drawing.SolidBrush $bg
  $g.FillPath($fillBrush, $path)
  $pen = New-Object System.Drawing.Pen $border, $strokeW
  $g.DrawPath($pen, $path)

  $fontSize = $size * 0.52
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $textBrush = New-Object System.Drawing.SolidBrush $fg
  $rect = New-Object System.Drawing.RectangleF 0, ($size * -0.02), $size, $size
  $g.DrawString("A", $font, $textBrush, $rect, $sf)

  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $g.Dispose(); $bmp.Dispose(); $path.Dispose(); $pen.Dispose(); $fillBrush.Dispose(); $textBrush.Dispose(); $font.Dispose()
}

$iconsDir = Join-Path $PSScriptRoot "..\icons"
foreach ($size in 16, 32, 48, 128) {
  $out = Join-Path $iconsDir "icon$size.png"
  New-IconPng -size $size -outPath $out
  Write-Host "Wrote $out"
}
