param(
    [Parameter(Mandatory = $true)][string]$WixDir,
    [string]$WebViewRuntime,
    [string]$Cargo = 'cargo',
    [switch]$Compact,
    [Parameter(Mandatory = $true)][string]$BuildDir,
    [Parameter(Mandatory = $true)][string]$OutputMsi
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
$wix = (Resolve-Path $WixDir).Path
$build = (New-Item -ItemType Directory -Path $BuildDir -Force).FullName
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputMsi)
$object = Join-Path $build 'StationPilot.wixobj'
$manifest = Join-Path $source 'rust/Cargo.toml'
$compactValue = 'no'
$productCode = '{450A00A2-E22F-4F08-8A65-CAF0955F1002}'
$config = @('--features', 'offline')
if ($Compact) {
    $compactValue = 'yes'
    $productCode = '{59352330-A9F0-40D0-ACDA-7E56A79DF9C2}'
    $config = @()
} elseif (!$WebViewRuntime) {
    throw 'Pass -WebViewRuntime for the offline installer.'
}

if (!(Test-Path (Join-Path $source 'pilot_dsp.wasm'))) {
    throw 'Build pilot_dsp.wasm from rust/dsp.rs before packaging.'
}

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $build 'target' }
& $Cargo build --locked --manifest-path $manifest --target-dir $targetDir --release @config
if ($LASTEXITCODE) { throw 'Rust launcher compilation failed.' }
Copy-Item (Join-Path $targetDir 'release/station-pilot.exe') (Join-Path $build 'StationPilot.exe') -Force
Copy-Item (Join-Path $PSScriptRoot 'StationPilot.ico') (Join-Path $build 'StationPilot.ico') -Force
$loader = Get-ChildItem (Join-Path $targetDir 'release/build') -Recurse -Filter 'WebView2Loader.dll' |
    Where-Object { $_.FullName -match '[\\/]webview2-com-sys(?:-|[\\/]).*[\\/]out[\\/]x64[\\/]WebView2Loader.dll$' } |
    Select-Object -First 1
if (!$loader) { throw 'The WebView2 loader was not produced by cargo.' }
Copy-Item $loader.FullName (Join-Path $build 'WebView2Loader.dll') -Force

$cargoMetadata = & $Cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-gnu --manifest-path $manifest
if ($LASTEXITCODE) { throw 'Could not retrieve the Rust dependency licenses.' }
$notices = [System.Text.StringBuilder]::new()
foreach ($dependency in (($cargoMetadata | ConvertFrom-Json).packages | Sort-Object name, version)) {
    if (!$dependency.source) { continue }
    [void]$notices.AppendLine("=== $($dependency.name) $($dependency.version) [$($dependency.license)] ===")
    foreach ($notice in (Get-ChildItem (Split-Path $dependency.manifest_path) -File | Where-Object Name -Match '^(LICENSE|COPYING|NOTICE)([._-]|$)')) {
        [void]$notices.AppendLine((Get-Content -LiteralPath $notice.FullName -Raw))
    }
}
[IO.File]::WriteAllText((Join-Path $build 'ThirdPartyNotices.txt'), $notices.ToString())

$tasks = Join-Path $build 'InstallerTasks.exe'
& $compiler '/nologo' '/optimize+' '/target:winexe' '/reference:System.Windows.Forms.dll' '/reference:System.Management.dll' "/out:$tasks" (Join-Path $PSScriptRoot 'InstallerTasks.cs')
if ($LASTEXITCODE) { throw 'Installer task compilation failed.' }

$linkInputs = @($object)
if (!$Compact) {
    $runtime = (Resolve-Path $WebViewRuntime).Path
    $runtimeSource = Join-Path $build 'FixedRuntime.wxs'
    $runtimeObject = Join-Path $build 'FixedRuntime.wixobj'
    & (Join-Path $wix 'heat.exe') dir $runtime -nologo -ag -scom -sreg -srd -cg FixedWebViewFiles -dr FixedRuntime -var var.Runtime -out $runtimeSource
    if ($LASTEXITCODE) { throw 'WebView2 runtime harvest failed.' }
    & (Join-Path $wix 'candle.exe') -nologo -arch x64 "-dRuntime=$runtime" -out $runtimeObject $runtimeSource
    if ($LASTEXITCODE) { throw 'WebView2 runtime compilation failed.' }
    $linkInputs += $runtimeObject
}

& (Join-Path $wix 'candle.exe') -nologo -arch x64 "-dCompact=$compactValue" "-dProductCode=$productCode" "-dBundle=$build" "-dSource=$source" -out $object (Join-Path $PSScriptRoot 'StationPilot.wxs')
if ($LASTEXITCODE) { throw 'WiX compilation failed.' }

& (Join-Path $wix 'light.exe') -nologo -sval -spdb -ext (Join-Path $wix 'WixUIExtension.dll') -out $output @linkInputs
if ($LASTEXITCODE) { throw 'MSI linking failed.' }
