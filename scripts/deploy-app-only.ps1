[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ResourceGroup,
  [Parameter(Mandatory = $true)][string]$AppName
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI was not found. Install it and run az login first.'
}

$null = az account show --output none
if ($LASTEXITCODE -ne 0) { throw 'Azure CLI is not signed in. Run az login first.' }

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "voyageai-app-$([guid]::NewGuid().ToString('N'))"
$zip = "$staging.zip"
try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  foreach ($file in @('index.html','server.cjs','package.json','package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $staging
  }
  foreach ($directory in @('assets','lib')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination $staging -Recurse
  }

  & tar.exe -a -c -f $zip -C $staging .
  if ($LASTEXITCODE -ne 0) { throw "Failed to create deployment archive: $zip" }

  az webapp deploy `
    --resource-group $ResourceGroup `
    --name $AppName `
    --src-path $zip `
    --type zip `
    --clean true `
    --restart true `
    --output none
  if ($LASTEXITCODE -ne 0) { throw 'App Service deployment failed.' }
} finally {
  if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
}

$hostName = az webapp show --resource-group $ResourceGroup --name $AppName --query defaultHostName -o tsv
if (-not $hostName) { throw 'Unable to determine the App Service hostname.' }
$healthUrl = "https://$hostName/api/health"

for ($attempt = 1; $attempt -le 36; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 15
    if ($health.status -eq 'ok' -and $health.account_store -eq 'cosmos' -and $health.account_state_persistence -eq $true) {
      Write-Host "Deployment completed: https://$hostName" -ForegroundColor Green
      Write-Host 'Account page-state persistence endpoint is active.' -ForegroundColor Green
      exit 0
    }
  } catch {}
  Start-Sleep -Seconds 5
}

throw "Deployment finished, but the expected health marker was not found: $healthUrl"
