# test_e2e.ps1 - End-to-end functional test for the GDS Navigator extension.
# Run:  powershell -ExecutionPolicy Bypass -File D:\gds-navigator-vscode\test_e2e.ps1
#
# Uses the isolated venv at .venv-fork (gds_design base + fangrh/gdsfactory fork
# installed editable with --no-deps). Delete that folder to roll back.

$py   = "D:\gds-navigator-vscode\.venv-fork\Scripts\python.exe"
$proj = "D:\gds_argo\testGDS"

Write-Host "== 1. Build GDS with provenance (local script, fork) ==" -ForegroundColor Cyan
Set-Location $proj
$env:GDS_PROVENANCE = "1"
# The fork needs an explicitly activated PDK; runpy keeps the real script path
# in the provenance records (exec would record "<string>").
& $py -c "import gdsfactory as gf; gf.gpdk.PDK.activate(); import runpy; runpy.run_path('scripts/mzi_example.py', run_name='__main__')"
$env:GDS_PROVENANCE = $null

Write-Host "`n== 2. Sidecar check ==" -ForegroundColor Cyan
Get-ChildItem gds\mzi_example* | Format-Table Name, Length, LastWriteTime | Out-Host
if (Test-Path gds\mzi_example.provenance.json) {
    $side = Get-Content gds\mzi_example.provenance.json -Raw | ConvertFrom-Json
    Write-Host "sidecar entries: $($side.entries.Count)" -ForegroundColor Green
} else {
    Write-Host "NO SIDECAR produced." -ForegroundColor Red
}

Write-Host "`n== 3. Parse check (extension pipeline) ==" -ForegroundColor Cyan
& $py D:\gds-navigator-vscode\python\parse_gds.py gds\mzi_example.gds > $env:TEMP\mzi_geo.json
# Save the parse output for the standalone browser test page (it prefers
# real_geojson.json over the built-in sample when served).
Copy-Item $env:TEMP\mzi_geo.json D:\gds-navigator-vscode\webview\real_geojson.json -Force
if ($LASTEXITCODE -eq 0) {
    $j = Get-Content $env:TEMP\mzi_geo.json -Raw | ConvertFrom-Json
    $withprov = @($j.features | Where-Object { $_.properties.provenance }).Count
    Write-Host "features: $($j.features.Count)   with provenance: $withprov" -ForegroundColor Green
} else {
    Write-Host "parse failed (exit $LASTEXITCODE)" -ForegroundColor Red
}

Write-Host "`n== 4. Launch VS Code Extension Development Host ==" -ForegroundColor Cyan
code --extensionDevelopmentPath=D:\gds-navigator-vscode $proj
Write-Host @"

In the host window: double-click gds/mzi_example.gds in the Explorer.
The workspace settings already point gdsNavigator at the fork venv, so no
environment selection is needed. For the rebuild flow use scripts/mzi_design.py
(it activates the PDK itself).

"@ -ForegroundColor Cyan
