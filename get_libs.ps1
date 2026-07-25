$files = @(
  'tf.min.js',
  'mobilenet.min.js',
  'chart.umd.min.js',
  'html2canvas.min.js',
  'jspdf.umd.min.js'
)

$missing = @()
foreach ($file in $files) {
  $path = Join-Path -Path $PSScriptRoot -ChildPath $file
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
    $missing += $file
  }
}

if ($missing.Count -gt 0) {
  $missing | ForEach-Object { Write-Error "Missing local library: $_" }
  Write-Error 'Restore a complete release package; this script does not download dependencies.'
  exit 1
}

Write-Host 'All bundled browser libraries are present.'
