<#
.SYNOPSIS
  處理軟體送簽佇列(S1-3;S1-SIGNING-DESIGN §3.2、§4.3、ADR 0005):以公司軟體發佈憑證重簽上傳的安裝檔,放進軟體庫。
  通常經 signing-workstation.ps1 software 呼叫。在簽章人員自己的電腦執行;S3 時搬到專用簽章機(-Unattended)。

.DESCRIPTION
  逐筆處理 <NasRoot>\sign-queue\{uploadId}.json(sign-job/1;還沒有 {uploadId}.result.json 的),**不採信工作單**:
    1. 工作單格式、schema、upload_id 與檔名一致、environment = -Environment、路徑規則(三段、每段英數與 . _ 空白 + -、.msi / .exe;與主機相同)
    1a. **向主機確認**(-GatewayUrl + -ApiKeyFile,API Key 只授 endpoint.software.sign-check):主機上這筆是 queued、核可人 ≠ 上傳者、
        路徑 / 雜湊 / 大小 / 上傳者 / 核可人與工作單相同。工作單可被能寫 sign-queue\ 的人偽造(資安審查 S1-3 M2),駁回後也可能殘留(M1);
        不是 queued 寫 rejected NOT_APPROVED,不一致寫 rejected JOB_MISMATCH,連不到主機就略過(下次重跑)。
        只有測試區可用 -SkipHostCheck(印警告)
    2. incoming\{路徑} 複製到本機暫存目錄後重算 SHA-256 與大小(必須 = 工作單);之後簽章與放置都用這份暫存
    3. software\{路徑} 已存在 → 拒絕 TARGET_EXISTS(不覆蓋)
    4. 原廠簽章(本機規則,不聽主機):簽章有效且簽章者指紋在 -VendorSigners 清單 → 自動(allowlist);
       否則顯示檔案資訊,簽章人員輸入 yes 才簽(manual)、輸入 reject 拒絕(VENDOR_NOT_ALLOWED)、其他略過留待下次;
       -Unattended 時直接拒絕
    5. 重簽(取代原有簽章):測試憑證以 Set-AuthenticodeSignature;正式憑證以 signtool sign /tr /td SHA256 + verify /pa,且要 Valid、有時間戳記
    6. 不覆蓋地放進 software\{路徑}(同目錄暫存檔 → 重算 → File.Move)
    7. 最後寫 {uploadId}.result.json(sign-result/1;暫存檔 → File.Move)。主機重算 software\ 實際檔案的雜湊確認後才標記 signed
  確定性的錯誤(格式 / 部署區 / 雜湊不符、目的地已存在、拒絕簽章)寫 rejected 結果;簽章失敗(token 沒插、時間戳記連不到)不寫結果,下次重跑。
  憑證規則與 sign-release.ps1 相同:只取 CurrentUser\My、要有私鑰;測試憑證(自簽或主旨含 "not for production")必須加 -Test;正式憑證禁止 -Test / -NoTimestamp。
  執行的 Windows 帳號要有 NAS sign-queue\ 讀寫、incoming\ 讀、software\ 寫入權(S1-5)。

  -VendorSigners(預設 %USERPROFILE%\.rustit\vendor-signers.json,簽章人員維護,不進 repo;範例 vendor-signers.example.json):
    { "signers": [ { "thumbprint": "<原廠簽章憑證 SHA-1 指紋>", "name": "Notepad++" } ] }

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\sign-software-queue.ps1 -Environment test -Thumbprint <測試憑證指紋> -Test -NoTimestamp -DryRun
#>
param(
    [Parameter(Mandatory)][ValidateSet('test', 'prod')][string]$Environment,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$Thumbprint,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$NoTimestamp,
    [switch]$Test,
    # NAS 區目錄(含 incoming\、sign-queue\、software\);不給時依 -Environment
    [string]$NasRoot,
    # 只處理這一筆
    [ValidatePattern('^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')][string]$Job = '',
    [string]$VendorSigners = (Join-Path $env:USERPROFILE '.rustit\vendor-signers.json'),
    [switch]$Unattended,
    # 向主機確認送簽狀態(必填;只有測試區可用 -SkipHostCheck)
    [string]$GatewayUrl,
    [string]$ApiKeyFile,
    [switch]$SkipHostCheck,
    # 只核對(格式、雜湊、原廠簽章),不簽章、不放檔、不寫結果
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($Environment -eq 'prod' -and ($Test -or $NoTimestamp)) { throw '正式區不可用 -Test / -NoTimestamp' }

# 向主機確認送簽狀態(與 publish-release.ps1 共用 Gateway API Key 規則)
. (Join-Path $PSScriptRoot 'gateway-api.ps1')
$apiKey = $null
if ($SkipHostCheck) {
    if ($Environment -ne 'test') { throw '-SkipHostCheck 只能用於測試區' }
    Write-Warning '-SkipHostCheck:不向主機確認送簽狀態,偽造或已駁回的工作單也會被簽(只用於本機測試)'
} else {
    if (-not $GatewayUrl -or -not $ApiKeyFile) { throw '要指定 -GatewayUrl 與 -ApiKeyFile(簽章前向主機確認送簽狀態)' }
    Assert-GatewayHost $GatewayUrl $Environment
    $apiKey = Read-GatewayApiKey $ApiKeyFile
}

$NasRoots = @{
    test = '\\10.10.130.31\docker-folder\RustIT\test'
    prod = '\\10.10.130.31\docker-folder\RustIT\prod'
}
if (-not $NasRoot) { $NasRoot = $NasRoots[$Environment] }
$NasRoot = $NasRoot.TrimEnd('\')
if ($NasRoot -ne $NasRoots[$Environment]) { Write-Warning "-NasRoot 不是 $Environment 區的 NAS 目錄($($NasRoots[$Environment])):$NasRoot(只用於本機測試)" }
$queueDir = Join-Path $NasRoot 'sign-queue'
$incomingDir = Join-Path $NasRoot 'incoming'
$softwareDir = Join-Path $NasRoot 'software'
foreach ($d in $queueDir, $incomingDir, $softwareDir) {
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { throw "連不到 $d(先以有 RustIT 寫入權的帳號 net use)" }
}

# 路徑規則(與 ItAgentBack software-files.ts splitSoftwarePath 相同)
$segment = '^(?:[A-Za-z0-9_+-]|[A-Za-z0-9_+-][A-Za-z0-9._ +-]{0,98}[A-Za-z0-9_+-])$'
function Test-SoftwarePath([string]$p) {
    if (-not $p -or $p.Length -gt 260) { return $false }
    $parts = $p.Split('/')
    if ($parts.Count -ne 3) { return $false }
    foreach ($x in $parts) { if ($x -cnotmatch $segment) { return $false } }
    return $parts[2] -match '\.(msi|exe)$'
}

# 本機廠商白名單(不聽主機)
$allow = @{}
if (Test-Path -LiteralPath $VendorSigners) {
    foreach ($v in @((Get-Content -LiteralPath $VendorSigners -Raw -Encoding UTF8 | ConvertFrom-Json).signers)) {
        if ($v.thumbprint -match '^[0-9A-Fa-f]{40}$') { $allow[$v.thumbprint.ToLower()] = [string]$v.name }
    }
    Write-Host "廠商白名單:$($allow.Count) 筆($VendorSigners)"
} else {
    Write-Warning "沒有廠商白名單 $VendorSigners:每筆都要人工確認"
}

# 簽章憑證(與 sign-release.ps1 相同規則)
$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($Thumbprint.ToUpper())" -ErrorAction SilentlyContinue
if (-not $cert) { throw "CurrentUser\My 找不到憑證 $Thumbprint" }
if (-not $cert.HasPrivateKey) { throw '憑證沒有私鑰(要在簽章人員的電腦、或插上憑證 token)' }
$isTestCert = ($cert.Subject -match 'not for production') -or ($cert.Subject -eq $cert.Issuer)
if ($isTestCert -and -not $Test) { throw '這是測試 / 自簽憑證:必須加 -Test(簽出的檔案只能上測試區)' }
if (-not $isTestCert -and $Test) { throw '-Test 只能搭配測試憑證' }
if ($NoTimestamp -and -not $Test) { throw '正式憑證禁止 -NoTimestamp(ADR 0003)' }
$signer = $cert.Thumbprint.ToLower()
Write-Host "簽章憑證:$($cert.Subject)($signer)"
if ($Test) { Write-Warning '測試模式:測試憑證,簽出的檔案只能上測試區' }
$signtool = $null
if (-not $Test -and -not $DryRun) {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { $signtool = $cmd.Source } else {
        $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $signtool) { throw '找不到 signtool.exe(安裝 Windows SDK 的 Signing Tools)' }
}

$utf8 = New-Object Text.UTF8Encoding $false
$operator = "$env:USERDOMAIN\$env:USERNAME"
function Write-Result([string]$id, [hashtable]$r) {
    $body = [ordered]@{ schema = 'sign-result/1'; upload_id = $id }
    foreach ($k in 'state', 'vendor_signer', 'vendor_signer_subject', 'vendor_check', 'signed_file', 'signed_sha256', 'signed_signer', 'signed_at', 'reject_code', 'reject_reason') {
        $body[$k] = $(if ($r.ContainsKey($k)) { $r[$k] } else { $null })
    }
    $body.operator = $operator
    $dest = Join-Path $queueDir "$id.result.json"
    $tmp = Join-Path $queueDir ".$id.result.json.tmp-$([guid]::NewGuid().ToString('N'))"
    [IO.File]::WriteAllText($tmp, ($body | ConvertTo-Json -Depth 3), $utf8)
    try { [IO.File]::Move($tmp, $dest) } catch {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        throw "無法寫入結果檔 $dest(已存在?):$($_.Exception.Message)"
    }
}
function Reject([string]$id, [string]$code, [string]$reason, [hashtable]$extra = @{}) {
    Write-Warning "拒絕 ${id}:$code $reason"
    if ($DryRun) { return }
    $r = @{ state = 'rejected'; reject_code = $code; reject_reason = $reason }
    foreach ($k in $extra.Keys) { $r[$k] = $extra[$k] }
    Write-Result $id $r
}

$jobs = @(Get-ChildItem -LiteralPath $queueDir -File -Filter '*.json' | Where-Object { $_.Name -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$' } | Sort-Object LastWriteTimeUtc)
if ($Job) { $jobs = @($jobs | Where-Object { $_.BaseName -eq $Job.ToLower() }) }
$jobs = @($jobs | Where-Object { -not (Test-Path -LiteralPath (Join-Path $queueDir "$($_.BaseName).result.json")) })
Write-Host "待處理的送簽工作單:$($jobs.Count) 筆"
$work = Join-Path ([IO.Path]::GetTempPath()) ('rustit-sign-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$stats = @{ signed = 0; rejected = 0; skipped = 0 }
try {
    foreach ($f in $jobs) {
        $id = $f.BaseName
        Write-Host ''
        Write-Host "=== $id ==="
        # 1. 工作單
        try { $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $j = $null }
        if (-not $j -or $j.schema -cne 'sign-job/1' -or $j.upload_id -cne $id -or -not (Test-SoftwarePath $j.file_name) -or
            $j.sha256 -cnotmatch '^[0-9a-f]{64}$' -or -not ($j.size_bytes -is [long] -or $j.size_bytes -is [int]) -or $j.size_bytes -le 0) {
            Reject $id 'INVALID_JOB' '工作單格式不符'; $stats.rejected++; continue
        }
        if ($j.environment -cne $Environment) { Reject $id 'ENVIRONMENT_MISMATCH' "工作單部署區 $($j.environment) 不是 $Environment"; $stats.rejected++; continue }
        Write-Host "檔案:$($j.file_name)($($j.size_bytes) 位元組)上傳 $($j.uploaded_by)、核可 $($j.approved_by) $($j.approved_at)"
        if ($apiKey) {
            $st = Invoke-GatewayGet $GatewayUrl $apiKey "/api/endpoint/software/uploads/$id/sign-status" $Environment
            if (-not $st.Ok) { Write-Warning "無法向主機確認 ${id}:$($st.Why)(未處理,下次重跑)"; $stats.skipped++; continue }
            $h = $st.Body
            if ($h.state -cne 'queued') { Reject $id 'NOT_APPROVED' "主機上這筆的狀態是 $($h.state),不是 queued(已駁回、不存在或偽造的工作單)"; $stats.rejected++; continue }
            if (-not $h.approvedBy -or $h.approvedBy -eq $h.uploadedBy -or $h.fileName -cne $j.file_name -or $h.sha256 -cne $j.sha256 -or
                [long]$h.sizeBytes -ne [long]$j.size_bytes -or $h.uploadedBy -cne $j.uploaded_by -or $h.approvedBy -cne $j.approved_by) {
                Reject $id 'JOB_MISMATCH' '工作單與主機的上傳紀錄不一致(路徑、雜湊、大小、上傳者或核可人)'; $stats.rejected++; continue
            }
            Write-Host "主機確認:queued,上傳 $($h.uploadedBy)、核可 $($h.approvedBy)"
        }
        $rel = $j.file_name -replace '/', '\'
        $src = Join-Path $incomingDir $rel
        $dest = Join-Path $softwareDir $rel
        if (Test-Path -LiteralPath $dest) { Reject $id 'TARGET_EXISTS' "軟體庫已有 $($j.file_name)(不覆蓋)"; $stats.rejected++; continue }
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Reject $id 'INCOMING_MISSING' "incoming 找不到 $($j.file_name)"; $stats.rejected++; continue }
        # 2. 複製到本機暫存後重算(之後只用這份)
        $local = Join-Path $work "$id$([IO.Path]::GetExtension($rel))"
        Copy-Item -LiteralPath $src -Destination $local
        $sha = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLower()
        if ($sha -ne $j.sha256 -or (Get-Item -LiteralPath $local).Length -ne $j.size_bytes) {
            Reject $id 'HASH_MISMATCH' 'incoming 檔案的雜湊或大小與工作單不同'; $stats.rejected++; continue
        }
        # 3. 原廠簽章(本機白名單)
        $orig = Get-AuthenticodeSignature -LiteralPath $local
        $vendor = if ($orig.SignerCertificate) { $orig.SignerCertificate.Thumbprint.ToLower() } else { $null }
        $vendorSubject = if ($orig.SignerCertificate) { $orig.SignerCertificate.Subject } else { $null }
        $vendorInfo = @{ vendor_signer = $vendor; vendor_signer_subject = $vendorSubject }
        Write-Host "原廠簽章:$($orig.Status)$(if ($vendor) { " $vendorSubject($vendor)" } else { '(未簽章)' })"
        if ($orig.Status -eq 'Valid' -and $vendor -and $allow.ContainsKey($vendor)) {
            $check = 'allowlist'
            Write-Host "白名單:$($allow[$vendor])"
        } elseif ($Unattended) {
            Reject $id 'VENDOR_NOT_ALLOWED' '原廠簽章不在白名單(無人值守不簽)' $vendorInfo; $stats.rejected++; continue
        } elseif ($DryRun) {
            Write-Host '[DryRun] 不在白名單:實際執行時會要求人工確認'; $stats.skipped++; continue
        } else {
            $answer = Read-Host "不在白名單。確認要以公司憑證簽這個檔案?輸入 yes 簽章、reject 拒絕,其他略過"
            if ($answer -ceq 'reject') { Reject $id 'VENDOR_NOT_ALLOWED' '簽章人員拒絕簽章' $vendorInfo; $stats.rejected++; continue }
            if ($answer -cne 'yes') { Write-Host '略過(留待下次)'; $stats.skipped++; continue }
            $check = 'manual'
        }
        if ($DryRun) { Write-Host "[DryRun] 核對通過($check),未簽章"; $stats.skipped++; continue }
        # 4. 重簽(取代原有簽章)
        try {
            if ($Test) {
                $a = @{ LiteralPath = $local; Certificate = $cert; HashAlgorithm = 'SHA256' }
                if (-not $NoTimestamp) { $a.TimestampServer = $TimestampUrl }
                $sig = Set-AuthenticodeSignature @a
                if (-not $sig.SignerCertificate) { throw "簽章失敗:$($sig.StatusMessage)" }
            } else {
                & $signtool sign /fd SHA256 /sha1 $Thumbprint /tr $TimestampUrl /td SHA256 $local
                if ($LASTEXITCODE -ne 0) { throw 'signtool sign 失敗' }
                & $signtool verify /pa $local | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'signtool verify /pa 失敗(憑證鏈要到受信任的根)' }
            }
            $chk = Get-AuthenticodeSignature -LiteralPath $local
            if (-not $chk.SignerCertificate -or $chk.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw '簽章後的簽章者不是軟體發佈憑證' }
            if (-not $Test -and ($chk.Status -ne 'Valid' -or -not $chk.TimeStamperCertificate)) { throw "簽章狀態 $($chk.Status) 或缺時間戳記" }
        } catch {
            # 可重試的錯誤:不寫結果,下次重跑
            Write-Warning "簽章失敗 ${id}:$($_.Exception.Message)(未寫結果,下次重跑)"; $stats.skipped++; continue
        }
        $signedSha = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLower()
        # 5. 不覆蓋地放進軟體庫
        $ddir = Split-Path -Parent $dest
        [void][IO.Directory]::CreateDirectory($ddir)
        $tmp = Join-Path $ddir ".$(Split-Path -Leaf $dest).tmp.$([guid]::NewGuid().ToString('N'))"
        try {
            Copy-Item -LiteralPath $local -Destination $tmp
            if ((Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower() -ne $signedSha) { throw '複製到軟體庫後雜湊不符' }
            try { [IO.File]::Move($tmp, $dest) } catch {
                if (Test-Path -LiteralPath $dest) { Reject $id 'TARGET_EXISTS' '放置時軟體庫已有同一路徑(不覆蓋)' $vendorInfo; $stats.rejected++; continue }
                throw
            }
        } finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        # 6. 結果(最後寫)
        Write-Result $id @{
            state = 'signed'; vendor_signer = $vendor; vendor_signer_subject = $vendorSubject; vendor_check = $check
            signed_file = $j.file_name; signed_sha256 = $signedSha; signed_signer = $signer; signed_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
        Write-Host "OK     $($j.file_name) $signedSha"
        $stats.signed++
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
Write-Host "完成:簽章 $($stats.signed)、拒絕 $($stats.rejected)、略過 $($stats.skipped)。主機每分鐘讀結果,重算軟體庫檔案確認後標記 signed;之後到 GigaItApp 照 P7 登錄套件。"
