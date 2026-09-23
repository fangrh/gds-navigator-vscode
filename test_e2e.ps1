# Reproducible integration journey. Uses only temporary layouts and test-owned windows.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & npm.cmd run test:vscode
    if ($LASTEXITCODE -ne 0) { throw 'GDS Navigator VS Code integration checks failed.' }
} finally {
    Pop-Location
}
