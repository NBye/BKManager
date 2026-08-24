Add-Type -AssemblyName System.Drawing

$outputDirectory = Join-Path $PSScriptRoot '..\public'
$sizes = @(16, 32, 48, 128)

function New-Icon([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scale = $size / 128
  $graphics.ScaleTransform($scale, $scale)

  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.RectangleF]::new(8, 8, 120, 120)), ([System.Drawing.Color]::FromArgb(37, 99, 235)), ([System.Drawing.Color]::FromArgb(79, 70, 229)), 45
  $backgroundPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $backgroundPath.AddArc(8, 8, 56, 56, 180, 90)
  $backgroundPath.AddArc(64, 8, 56, 56, 270, 90)
  $backgroundPath.AddArc(64, 64, 56, 56, 0, 90)
  $backgroundPath.AddArc(8, 64, 56, 56, 90, 90)
  $backgroundPath.CloseFigure()
  $graphics.FillPath($background, $backgroundPath)

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $bookmark = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bookmark.AddLine(39, 29, 39, 99)
  $bookmark.AddLine(39, 99, 64, 84)
  $bookmark.AddLine(64, 84, 89, 99)
  $bookmark.AddLine(89, 99, 89, 29)
  $bookmark.CloseFigure()
  $graphics.FillPath($white, $bookmark)

  $blueLine = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(191, 219, 254)), 6
  $blueLine.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $blueLine.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($blueLine, 49, 36, 79, 36)
  $graphics.DrawLine($blueLine, 49, 48, 71, 48)

  $green = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(167, 243, 208)), 6
  $green.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $green.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawArc($green, 78, 74, 20, 14, 270, 180)
  $graphics.DrawLine($green, 87, 82, 82, 88)
  $graphics.DrawLine($green, 82, 88, 87, 94)

  $yellow = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(253, 230, 138)), 6
  $yellow.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $yellow.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawArc($yellow, 30, 56, 20, 14, 90, 180)
  $graphics.DrawLine($yellow, 41, 62, 46, 56)
  $graphics.DrawLine($yellow, 46, 56, 41, 50)

  $path = Join-Path $outputDirectory ("icon{0}.png" -f $size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $background.Dispose(); $backgroundPath.Dispose(); $white.Dispose(); $bookmark.Dispose(); $blueLine.Dispose(); $green.Dispose(); $yellow.Dispose(); $bitmap.Dispose()
}

foreach ($size in $sizes) { New-Icon $size }
