<#
.SYNOPSIS
  簽章人員的簽章腳本(P6-4;ADR 0003、PLATFORM-PLAN §4.9 選項 C;P6-UPGRADE-DESIGN §6)。在**簽章人員自己的電腦**執行,不在 CI。

.DESCRIPTION
  輸入:build-release.ps1 的產出目錄(CI artifact 解壓後的 release-out\,含 SHA256SUMS.txt、RELEASE-INFO.txt)。
  1. 核對:SHA256SUMS.txt 只允許三種精確路徑(agent\<版本>\rustit-agent.exe、watchdog\<版本>\rustit-watchdog.exe、msi\GigaNexusAgent-<版本>-<test|prod>.msi,
     小寫、正斜線);每個檔案雜湊都對得上、ProductVersion = 路徑的版本、不是連結(junction / symlink);目錄裡沒有清單以外的任何檔案
     (只放行 SHA256SUMS.txt、RELEASE-INFO.txt)。任何一項不符就整批中止,什麼都不簽
  2. 印出來源(RELEASE-INFO 的 commit / pipeline)與清單,**要你輸入 YES 才簽**(-Yes 略過,只給自動化測試);-ExpectedCommit <sha> 可要求 commit 一致
  3. 簽章憑證只取 CurrentUser\My(要有私鑰,正式憑證應在智慧卡 / token)。是否為測試憑證由**憑證本身**判定(自簽或主旨含 "not for production"):
     測試憑證必須加 -Test;正式憑證禁止 -Test 與 -NoTimestamp
  4. 逐一簽章:signtool sign /fd SHA256 /sha1 <指紋> /tr <時間戳記> /td SHA256(ADR 0003:時間戳記一定要加);正式憑證再 signtool verify /pa、
     狀態必須 Valid 且有時間戳記
  5. 寫 SHA256SUMS.signed.txt(簽章後的雜湊)與 SIGNED-INFO.txt(簽章者、test_mode、時間);原 SHA256SUMS.txt 不改
  簽章中途失敗:目錄可能已部分簽章(留有 SIGNING-IN-PROGRESS.txt),不能重跑 → 回到 CI 的原始 artifact 重新解壓再簽。

  殘餘風險(選項 C 的本質):雜湊清單與 exe 來自同一個建置來源,**雜湊只能證明傳輸沒壞,不能證明檔案出自哪份原始碼**。簽章前請依 docs/RUNBOOK.md §1
  核對來源(只從受保護 tag 的 pipeline 取 artifact、核對 tag 的 commit 與 diff;最穩的做法是你自己從該 tag 的 commit 重建後簽自己建的檔案)。
  執行本腳本請用**受保護 tag 或 main 的 checkout**,不要用 feature 分支的版本(腳本本身也在信任鏈內)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\sign-release.ps1 -Dir C:\release-out -Thumbprint <正式憑證指紋> -ExpectedCommit <tag 的 commit>
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\sign-release.ps1 -Dir C:\release-out -Thumbprint <測試憑證指紋> -Test -NoTimestamp
#>
param(
    [Parameter(Mandatory)][string]$Dir,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$Thumbprint,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$NoTimestamp,
    [switch]$Test,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCommit,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$dirPrefix = $Dir.TrimEnd('\') + '\'
$sumsFile = Join-Path $Dir 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $sumsFile)) { throw "找不到 $sumsFile(要用 build-release.ps1 的產出目錄)" }
if (Test-Path -LiteralPath (Join-Path $Dir 'SIGNING-IN-PROGRESS.txt')) { throw '上次簽章中途失敗(有 SIGNING-IN-PROGRESS.txt),目錄可能已部分簽章:回到 CI 的原始 artifact 重新解壓再簽' }
if (Test-Path -LiteralPath (Join-Path $Dir 'SHA256SUMS.signed.txt')) { throw '這個目錄已經簽過章(有 SHA256SUMS.signed.txt);重新簽請回到 CI 的原始 artifact' }

# 1. 清單:精確白名單(小寫、正斜線;-cmatch 區分大小寫)
$semver = '[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,20})?'
$allowed = "^(?:agent/($semver)/rustit-agent\.exe|watchdog/($semver)/rustit-watchdog\.exe|msi/GigaNexusAgent-($semver)-(?:test|prod)\.msi)$"
$listed = [ordered]@{}
foreach ($line in (Get-Content -LiteralPath $sumsFile -Encoding UTF8)) {
    if (-not $line.Trim()) { continue }
    if ($line -cnotmatch '^([0-9a-f]{64})  (.+)$') { throw "SHA256SUMS.txt 格式錯誤:$line" }
    $sha = $Matches[1]; $rel = $Matches[2]
    if ($rel -cnotmatch $allowed) { throw "清單只允許 agent / watchdog 的 exe 與 msi 的精確路徑,不接受:$rel" }
    $ver = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }
    if ($listed.Contains($rel)) { throw "清單重複:$rel" }
    $listed[$rel] = [pscustomobject]@{ Sha = $sha; Version = $ver; IsMsi = $rel.StartsWith('msi/') }
}
if ($listed.Count -eq 0) { throw 'SHA256SUMS.txt 是空的' }

function Test-Reparse([string]$path) { ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
$bad = @()
$fullOf = @{}
foreach ($rel in $listed.Keys) {
    $full = [IO.Path]::GetFullPath((Join-Path $Dir ($rel -replace '/', '\')))
    if (-not $full.StartsWith($dirPrefix, [StringComparison]::OrdinalIgnoreCase)) { $bad += "路徑跑出目錄:$rel"; continue }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $bad += "缺檔:$rel"; continue }
    $fullOf[$rel] = $full
    if (Test-Reparse $full) { $bad += "是連結(junction / symlink):$rel"; continue }
    $h = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $listed[$rel].Sha) { $bad += "雜湊不符:$rel(清單 $($listed[$rel].Sha.Substring(0, 12))…,實際 $($h.Substring(0, 12))…)" }
    if (-not $listed[$rel].IsMsi -and (Get-Item -LiteralPath $full).VersionInfo.ProductVersion -ne $listed[$rel].Version) {
        $bad += "ProductVersion 與路徑的版本不符:$rel($((Get-Item -LiteralPath $full).VersionInfo.ProductVersion))"
    }
}
# 目錄裡不能有清單與兩個說明檔以外的任何東西(含 dll / ps1 / 連結)
foreach ($f in (Get-ChildItem -LiteralPath $Dir -Recurse -Force -File)) {
    $rel = $f.FullName.Substring($dirPrefix.Length) -replace '\\', '/'
    if ($rel -ceq 'SHA256SUMS.txt' -or $rel -ceq 'RELEASE-INFO.txt') { continue }
    if (-not $listed.Contains($rel)) { $bad += "清單以外的檔案:$rel" }
}
foreach ($d in (Get-ChildItem -LiteralPath $Dir -Recurse -Force -Directory)) { if (Test-Reparse $d.FullName) { $bad += "目錄是連結:$($d.FullName.Substring($dirPrefix.Length))" } }
if ($bad.Count -gt 0) { $bad | ForEach-Object { Write-Error $_ -ErrorAction Continue }; throw "核對失敗(共 $($bad.Count) 項),什麼都沒簽" }
Write-Host "核對通過:$($listed.Count) 個檔案雜湊、路徑、版本與 SHA256SUMS.txt 一致,目錄沒有清單以外的檔案"

# 2. 來源與人工確認
$release = @{}
$infoPath = Join-Path $Dir 'RELEASE-INFO.txt'
if (Test-Path -LiteralPath $infoPath) { foreach ($l in (Get-Content -LiteralPath $infoPath -Encoding UTF8)) { if ($l -match '^([a-z_]+)=(.*)$') { $release[$Matches[1]] = $Matches[2] } } }
Write-Host ("來源:commit={0} dirty={1} pipeline={2} job={3}" -f $release['commit'], $release['dirty'], $release['ci_pipeline'], $release['ci_job'])
if ($ExpectedCommit -and $release['commit'] -ne $ExpectedCommit) { throw "RELEASE-INFO 的 commit($($release['commit']))與 -ExpectedCommit($ExpectedCommit)不一致,什麼都沒簽" }
if (-not $ExpectedCommit) { Write-Warning '沒有 -ExpectedCommit:請先確認 artifact 來自受保護 tag 的 pipeline、commit 與 tag 一致(docs/RUNBOOK.md §1)' }
$listed.GetEnumerator() | ForEach-Object { Write-Host ("  {0}  {1}" -f $_.Value.Sha.Substring(0, 16), $_.Key) }

# 3. 憑證(只取 CurrentUser\My)
$thumb = $Thumbprint.ToUpper()
$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumb" -ErrorAction SilentlyContinue
if (-not $cert) { throw "CurrentUser\My 找不到憑證 $Thumbprint(正式憑證要在簽章人員的帳號下,最好在智慧卡 / token)" }
if (-not $cert.HasPrivateKey) { throw '憑證沒有私鑰(要在簽章人員的電腦、或插上憑證 token)' }
$isTestCert = ($cert.Subject -match 'not for production') -or ($cert.Subject -eq $cert.Issuer)
if ($isTestCert -and -not $Test) { throw '這是測試 / 自簽憑證:必須加 -Test(簽出的檔案只能上測試區);正式發版請用正式憑證' }
if (-not $isTestCert -and $Test) { throw '-Test 只能搭配測試憑證' }
if ($NoTimestamp -and -not $Test) { throw '正式憑證禁止 -NoTimestamp(ADR 0003:時間戳記一定要加,憑證過期後舊檔才仍有效)' }
Write-Host "簽章憑證:$($cert.Subject)($($cert.Thumbprint.ToLower()))"
if ($Test) { Write-Warning '測試模式:測試憑證,簽出的檔案只能上測試區,不可用於正式發版' }

if (-not $Yes) {
    $answer = Read-Host "確認以上 $($listed.Count) 個檔案要用此憑證簽章?輸入 YES"
    if ($answer -cne 'YES') { throw '已取消,什麼都沒簽' }
}

$signtool = $null
if (-not $Test) {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { $signtool = $cmd.Source } else {
        $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $signtool) { throw '找不到 signtool.exe(安裝 Windows SDK 的 Signing Tools)' }
}

# 4. 簽章 + 驗證(就地簽;先留標記,中途失敗時不能重跑)
[IO.File]::WriteAllText((Join-Path $Dir 'SIGNING-IN-PROGRESS.txt'), "簽章開始 $([DateTime]::UtcNow.ToString('o'))`n", (New-Object Text.UTF8Encoding $false))
$results = @()
foreach ($rel in $listed.Keys) {
    $p = $fullOf[$rel]
    $before = (Get-Item -LiteralPath $p).VersionInfo.ProductVersion
    # 簽章前再算一次雜湊(縮小核對到簽章之間的空窗)
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -ne $listed[$rel].Sha) { throw "簽章前雜湊改變:$rel" }
    if ($Test) {
        $a = @{ LiteralPath = $p; Certificate = $cert; HashAlgorithm = 'SHA256' }
        if (-not $NoTimestamp) { $a.TimestampServer = $TimestampUrl }
        $sig = Set-AuthenticodeSignature @a
        if (-not $sig.SignerCertificate) { throw "簽章失敗 ${rel}:$($sig.StatusMessage)" }
    } else {
        & $signtool sign /fd SHA256 /sha1 $Thumbprint /tr $TimestampUrl /td SHA256 $p
        if ($LASTEXITCODE -ne 0) { throw "signtool sign 失敗:$rel" }
        & $signtool verify /pa $p | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "signtool verify /pa 失敗:$rel(憑證鏈要到受信任的根)" }
    }
    $chk = Get-AuthenticodeSignature -LiteralPath $p
    if (-not $chk.SignerCertificate -or $chk.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw "簽章者不符:$rel" }
    if (-not $Test) {
        if ($chk.Status -ne 'Valid') { throw "簽章狀態不是 Valid:$rel($($chk.Status))" }
        if (-not $chk.TimeStamperCertificate) { throw "簽章沒有時間戳記:$rel" }
    }
    if ((Get-Item -LiteralPath $p).VersionInfo.ProductVersion -ne $before) { throw "簽章後版本資源改變:$rel" }
    $results += [pscustomobject]@{ File = $rel; Version = $before; Status = "$($chk.Status)"; Sha256 = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
}

# 5. 輸出
$utf8 = New-Object Text.UTF8Encoding $false
$signedLines = foreach ($r in ($results | Sort-Object File)) { '{0}  {1}' -f $r.Sha256, $r.File }
[IO.File]::WriteAllText((Join-Path $Dir 'SHA256SUMS.signed.txt'), (($signedLines -join "`n") + "`n"), $utf8)
$info = @(
    "signer_thumbprint=$($cert.Thumbprint.ToLower())",
    "signer_subject=$($cert.Subject)",
    "signed_by=$($env:USERDOMAIN)\$($env:USERNAME)",
    "signed_at=$([DateTime]::UtcNow.ToString('o'))",
    "timestamp=$(if ($NoTimestamp) { 'none' } else { $TimestampUrl })",
    "test_mode=$([bool]$isTestCert)",
    "source_commit=$($release['commit'])",
    "source_sums_sha256=$((Get-FileHash -LiteralPath $sumsFile -Algorithm SHA256).Hash.ToLower())"
)
[IO.File]::WriteAllText((Join-Path $Dir 'SIGNED-INFO.txt'), (($info -join "`n") + "`n"), $utf8)
Remove-Item -LiteralPath (Join-Path $Dir 'SIGNING-IN-PROGRESS.txt')

Write-Host ''
$results | Format-Table File, Version, Status, @{ n = 'SHA-256(前 16 碼)'; e = { $_.Sha256.Substring(0, 16) } } -AutoSize | Out-String | Write-Host
Write-Host "完成:$Dir\SHA256SUMS.signed.txt、SIGNED-INFO.txt"
Write-Host '下一步:installer\publish-release.ps1 -Environment test|prod 上架到版本檔目錄,再到 GigaItApp「Agent 版本」登錄(預期簽章者指紋見 SIGNED-INFO.txt)。'
