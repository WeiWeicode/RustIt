<#
.SYNOPSIS
  簽章工作站(S1-2;S1-SIGNING-DESIGN §3、ADR 0005)。在簽章人員自己的電腦執行;S3 時同一支腳本搬到專用簽章機。

.DESCRIPTION
  release 模式:Agent / Watchdog 發版的「簽章 + 上架」一次完成,任一步失敗就停止(不會簽了沒放又不知道):
    1. -Artifact 是 CI 產物 zip 時,解壓到新的暫存目錄(每次都是乾淨目錄,簽章失敗不必再找原始 artifact);
       是目錄時直接使用(與 sign-release.ps1 相同:已簽過或簽到一半的目錄會被拒絕)
    2. sign-release.ps1:核對清單、雜湊、版本,輸入 YES 後簽章
    3. publish-release.ps1:重新核對、版本號查重、放到 NAS 版本檔目錄,印出登錄資料
  核對與簽章邏輯都在上面兩支腳本,本腳本只負責串接;參數照原樣轉交。
  software 模式(NAS 送簽佇列)在 S1-3 後端完成後加入(設計 §3.2)。

  請用**受保護 tag 或 main 的 checkout** 執行(腳本本身在信任鏈內;RUNBOOK §1)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\signing-workstation.ps1 release -Artifact C:\Users\me\Downloads\artifacts.zip -Environment test -Thumbprint <測試憑證指紋> -Test -NoTimestamp
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\signing-workstation.ps1 release -Artifact C:\release-out -Environment prod -Thumbprint <正式憑證指紋> -ExpectedCommit <tag 的 commit> -HostAlias host3 -ServerContainer <容器>
#>
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('release')][string]$Mode,
    [Parameter(Mandatory)][string]$Artifact,
    [Parameter(Mandatory)][ValidateSet('test', 'prod')][string]$Environment,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$Thumbprint,
    # 以下轉交 sign-release.ps1
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$NoTimestamp,
    [switch]$Test,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCommit,
    # 以下轉交 publish-release.ps1(只轉交有指定的)
    [string]$HostAlias,
    [string]$NasReleasesDir,
    [string]$MountCheckDir,
    [string]$ServerContainer,
    [switch]$SkipRegistryCheck,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($Environment -eq 'prod' -and ($Test -or $NoTimestamp)) { throw '正式區不可用 -Test / -NoTimestamp' }

# 1. 取得產出目錄(含 SHA256SUMS.txt)
$src = (Resolve-Path -LiteralPath $Artifact).Path
if (Test-Path -LiteralPath $src -PathType Leaf) {
    if ([IO.Path]::GetExtension($src) -ne '.zip') { throw "-Artifact 要是 CI 產物 zip 或解壓後的目錄:$src" }
    $work = Join-Path ([IO.Path]::GetTempPath()) ('rustit-release-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $src -DestinationPath $work
    # GitLab 產物 zip 內是 release-out\…;只接受恰好一個含 SHA256SUMS.txt 的目錄
    $found = @(Get-ChildItem -LiteralPath $work -Recurse -Filter 'SHA256SUMS.txt' -File | ForEach-Object { $_.DirectoryName })
    if ($found.Count -ne 1) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        throw "zip 內應恰好有一個 SHA256SUMS.txt(找到 $($found.Count) 個):$src"
    }
    $dir = $found[0]
    Write-Host "已解壓到 $dir"
} else {
    $dir = $src
}

# 2. 簽章
$signArgs = @{ Dir = $dir; Thumbprint = $Thumbprint; TimestampUrl = $TimestampUrl }
if ($NoTimestamp) { $signArgs.NoTimestamp = $true }
if ($Test) { $signArgs.Test = $true }
if ($ExpectedCommit) { $signArgs.ExpectedCommit = $ExpectedCommit }
& (Join-Path $PSScriptRoot 'sign-release.ps1') @signArgs

# 3. 上架
$pubArgs = @{ Dir = $dir; Environment = $Environment }
foreach ($k in 'HostAlias', 'NasReleasesDir', 'MountCheckDir', 'ServerContainer') {
    if ($PSBoundParameters.ContainsKey($k)) { $pubArgs[$k] = $PSBoundParameters[$k] }
}
if ($SkipRegistryCheck) { $pubArgs.SkipRegistryCheck = $true }
if ($DryRun) { $pubArgs.DryRun = $true }
& (Join-Path $PSScriptRoot 'publish-release.ps1') @pubArgs

Write-Host ''
Write-Host "已簽章的目錄:$dir(登錄完成後可刪除)"
