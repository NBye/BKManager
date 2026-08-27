param(
  [string]$PackageRoot = (Join-Path (Get-Location) 'dist')
)

$manifestPath = Join-Path $PackageRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing $manifestPath" }
$required = @('background.js', 'src/popup.html', 'src/manager.html', 'src/options.html', 'src/capture.html', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png')
foreach ($relativePath in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relativePath))) { throw "Missing package entry or icon: $relativePath" }
}
Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Where-Object { $_.Extension -in @('.pem', '.key', '.crx') } | ForEach-Object {
  throw "Package contains sensitive file: $($_.FullName)"
}
Write-Output 'Package check passed.'
