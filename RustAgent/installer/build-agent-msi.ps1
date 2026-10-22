<#
.SYNOPSIS
  建置 GigaNexus Agent 監控 MSI(PLATFORM-PLAN §4.1、§4.9)。依部署區各建一個 MSI,設定在建置時寫入。

.DESCRIPTION
  1. cargo build --release -p rustit-agent -p rustit-watchdog(P5-2 起 MSI 含兩個服務;MSI 版本號跟 Agent)
  2. 產生 agent.toml(server_url、[tls] ca_file、store_issuer;裝置憑證一律讀 LocalMachine\My;
     [upgrade] trusted_signers:升級檔簽章者 SHA-1 指紋的本機信任清單,P6-2 起。沒有給 = 端點拒絕任何升級檔;
     [software] trusted_signers:軟體派送安裝檔簽章者的本機信任清單,P7-3 起,與升級分開。沒有給 = 端點拒絕任何派送的套件)
  3. wix build installer\agent.wxs → dist\msi\GigaNexusAgent-<版本>-<部署區>.msi,並印出 SHA-256

  需要:Rust(MSVC)、WiX v5(dotnet tool install --global wix --version 5.0.2;v6 起企業使用需付 OSMF,不使用)。
  產出的 MSI 未簽章;正式發版由簽章人員以人工簽章(PLATFORM-PLAN §4.9 選項 C)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\build-agent-msi.ps1 -Env test -Gateway 10.10.130.124:9443 -StoreIssuer "GigaNexus Temporary Agent CA (test)" -CaFile dist\rustit-agent-test\pki\ca.crt -TrustedSigners a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 -SoftwareSigners c3d4e5f60718293a4b5c6d7e8f9012345678a1b2
#>
param(
    [Parameter(Mandatory)][ValidateSet('test', 'prod')][string]$Env,
    # Gateway :9443 以 IP 設定(Gateway PRD Q1),例 10.10.130.124:9443
    [Parameter(Mandatory)][ValidatePattern('^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$')][string]$Gateway,
    # 裝置憑證簽發者名稱(Agent 專用中繼 CA)所含字串
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$StoreIssuer,
    # 驗證 Gateway 的根憑證(PEM)
    [Parameter(Mandatory)][string]$CaFile,
    # 升級檔簽章者 SHA-1 指紋(40 個十六進位字元;換憑證時可同時列新舊,最多 8 個)。測試期:installer\new-test-signing-cert.ps1 印出的指紋
    [ValidateCount(0, 8)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string[]]$TrustedSigners = @(),
    # 軟體派送安裝檔簽章者 SHA-1 指紋(廠商或公司加簽憑證;最多 8 個)。與 -TrustedSigners 分開:派送用的廠商憑證不可用來升級 Agent(P7-3)
    [ValidateCount(0, 8)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string[]]$SoftwareSigners = @()
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
if ($TrustedSigners.Count -eq 0) { Write-Warning '沒有 -TrustedSigners:安裝後端點會拒絕任何升級檔(SIGNER_NOT_TRUSTED)' }
$signers = ($TrustedSigners | ForEach-Object { '"' + $_.ToLower() + '"' }) -join ', '
$overlap = @($SoftwareSigners | Where-Object { $TrustedSigners -contains $_ })
if ($overlap.Count -gt 0) { Write-Warning "同一指紋同時在 -TrustedSigners 與 -SoftwareSigners:派送用的憑證也能升級 Agent,抵銷兩份清單分開的目的($($overlap -join ', '))" }
if ($SoftwareSigners.Count -eq 0) { Write-Warning '沒有 -SoftwareSigners:安裝後端點會拒絕任何派送的軟體(SIGNER_NOT_TRUSTED)' }
$swSigners = ($SoftwareSigners | ForEach-Object { '"' + $_.ToLower() + '"' }) -join ', '
$toml = @"
# 由 installer\build-agent-msi.ps1 產生($Env,rustit-agent $version);要修改請重新建置 MSI
server_url = "https://$Gateway"

[tls]
ca_file = "pki/ca.crt"
store_issuer = "$StoreIssuer"

[upgrade]
# 升級檔簽章者 SHA-1 指紋(必須同時在主機下發的 signer_thumbprints 內,P6-UPGRADE-DESIGN §9-2)
trusted_signers = [$signers]

[software]
# 軟體派送安裝檔簽章者 SHA-1 指紋(主機清單非空時必須同時在其中;draft 套件也必須在此清單,P7-SOFTWARE-DESIGN §5.2)
trusted_signers = [$swSigners]
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
