Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$runnerDirectory = if ($env:COMPANY_DATA_DIR) { $env:COMPANY_DATA_DIR } else { Join-Path $PSScriptRoot '.local/data' }
New-Item -ItemType Directory -Path $runnerDirectory -Force | Out-Null
$runnerLock = Join-Path $runnerDirectory 'runner.lock'
$runnerAlive = $false
if (Test-Path -LiteralPath $runnerLock) {
    $runnerProcessId = Get-Content -LiteralPath $runnerLock -Raw
    $runnerAlive = $null -ne (Get-Process -Id ([int]$runnerProcessId) -ErrorAction SilentlyContinue)
}
if (-not $runnerAlive) {
    $nodePath = (Get-Command node).Source
    Start-Process -FilePath $nodePath -ArgumentList 'server/runner.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runnerDirectory 'runner-output.log') -RedirectStandardError (Join-Path $runnerDirectory 'runner-error.log') | Out-Null
}
npm run dev
