<#
.SYNOPSIS
  建置 GigaNexus Agent 監控 MSI(PLATFORM-PLAN §4.1、§4.9)。依部署區各建一個 MSI,設定在建置時寫入。

.DESCRIPTION
  1. cargo build --release -p rustit-agent -p rustit-watchdog(P5-2 起 MSI 含兩個服務;MSI 版本號跟 Agent)
  2. 產生 agent.toml(server_url、[tls] ca_file、store_issuer;裝置憑證一律讀 LocalMachine\My)
  3. wix build installer\agent.wxs → dist\msi\GigaNexusAgent-<版本>-<部署區>.msi,並印出 SHA-256

  需要:Rust(MSVC)、WiX v5(dotnet tool install --global wix --version 5.0.2;v6 起企業使用需付 OSMF,不使用)。
  產出的 MSI 未簽章;正式發版由簽章人員以人工簽章(PLATFORM-PLAN §4.9 選項 C)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\build-agent-msi.ps1 -Env test -Gateway 10.10.130.124:9443 -StoreIssuer "GigaNexus Temporary Agent CA (test)" -CaFile dist\rustit-agent-test\pki\ca.crt
#>
param(
    [Parameter(Mandatory)][ValidateSet('test', 'prod')][string]$Env,
    # Gateway :9443 以 IP 設定(Gateway PRD Q1),例 10.10.130.124:9443
    [Parameter(Mandatory)][ValidatePattern('^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$')][string]$Gateway,
    # 裝置憑證簽發者名稱(Agent 專用中繼 CA)所含字串
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$StoreIssuer,
    # 驗證 Gateway 的根憑證(PEM)
    [Parameter(Mandatory)][string]$CaFile
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # RustAgent\
Set-Location $root

if (-not (Test-Path $CaFile -PathType Leaf)) { throw "找不到根憑證 $CaFile" }
if (-not (Select-String -Path $CaFile -Pattern 'BEGIN CERTIFICATE' -Quiet)) { throw "根憑證不是 PEM:$CaFile" }
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) { throw '找不到 wix:dotnet tool install --global wix --version 5.0.2' }
$wixVersion = (& wix --version) -replace '\+.*$', ''
if (-not $wixVersion.StartsWith('5.')) { throw "需要 WiX v5(目前 $wixVersion);v6 起企業使用需付 OSMF" }

$version = (Select-String -Path 'crates\agent\Cargo.toml' -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value
Write-Host "建置 rustit-agent $version(release)"
cargo build --release -p rustit-agent -p rustit-watchdog
if ($LASTEXITCODE -ne 0) { throw 'cargo build 失敗' }

$stage = Join-Path $root "target\msi-stage\$Env"
New-Item -ItemType Directory -Force $stage | Out-Null
$toml = @"
# 由 installer\build-agent-msi.ps1 產生($Env,rustit-agent $version);要修改請重新建置 MSI
server_url = "https://$Gateway"

[tls]
ca_file = "pki/ca.crt"
store_issuer = "$StoreIssuer"
"@
$tomlPath = Join-Path $stage 'agent.toml'
[IO.File]::WriteAllText($tomlPath, $toml.Replace("`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))

$out = Join-Path $root 'dist\msi'
New-Item -ItemType Directory -Force $out | Out-Null
$msi = Join-Path $out "GigaNexusAgent-$version-$Env.msi"
& wix build installer\agent.wxs -arch x64 -o $msi `
    -d "Version=$version" -d "Env=$Env" `
    -d "AgentExe=$(Resolve-Path target\release\rustit-agent.exe)" `
    -d "WatchdogExe=$(Resolve-Path target\release\rustit-watchdog.exe)" `
    -d "AgentToml=$tomlPath" -d "CaFile=$(Resolve-Path $CaFile)"
if ($LASTEXITCODE -ne 0) { throw 'wix build 失敗' }

$hash = (Get-FileHash $msi -Algorithm SHA256).Hash.ToLower()
Write-Host "完成:$msi"
Write-Host "SHA-256:$hash"
