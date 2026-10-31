# Capture la fenêtre de LoL BOT sans dépendre du premier plan (PrintWindow).
#
# La capture écran classique est inutilisable si une autre application plein
# écran recouvre LoL BOT ; `PrintWindow` demande à la fenêtre de se dessiner
# elle-même dans un bitmap, ce qui fonctionne aussi si elle est recouverte.
#
# Usage :
#   pwsh -File scripts/capture-window.ps1 -OutputPath "docs\v0.1-champions.png"
#   pwsh -File scripts/capture-window.ps1 -ProcessName "lol-bot" -WaitSeconds 30

param(
    [string]$ProcessName = "lol-bot",
    [string]$OutputPath = "docs\v0.1-champions.png",
    [int]$WaitSeconds = 45
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeWindow {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# DPI : garantit des dimensions de fenêtre en pixels physiques.
[NativeWindow]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$process = $null
$handle = [IntPtr]::Zero

while ((Get-Date) -lt $deadline) {
    $process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and [NativeWindow]::IsWindowVisible($_.MainWindowHandle) } |
        Select-Object -First 1
    if ($process) {
        $handle = $process.MainWindowHandle
        break
    }
    Start-Sleep -Milliseconds 400
}

if (-not $process -or $handle -eq [IntPtr]::Zero) {
    throw "Fenêtre visible introuvable pour le processus '$ProcessName' (attente ${WaitSeconds}s)."
}

if ([NativeWindow]::IsIconic($handle)) {
    [NativeWindow]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
    Start-Sleep -Milliseconds 1200
}

# Rectangle réel de la fenêtre (hors ombre DWM si disponible).
$rect = New-Object NativeWindow+RECT
$dwmOk = $false
try {
    $dwmOk = ([NativeWindow]::DwmGetWindowAttribute($handle, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect)) -eq 0)
} catch {
    $dwmOk = $false
}
if (-not $dwmOk) {
    [NativeWindow]::GetWindowRect($handle, [ref]$rect) | Out-Null
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    throw "Rectangle de fenêtre invalide : ${width}x${height}."
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
    $drawn = [NativeWindow]::PrintWindow($handle, $hdc, 2)   # PW_RENDERFULLCONTENT
} finally {
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
}
if (-not $drawn) {
    $bitmap.Dispose()
    throw "PrintWindow a échoué pour la fenêtre $handle."
}

$outputFull = Join-Path (Get-Location) $OutputPath
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputFull) | Out-Null
$bitmap.Save($outputFull, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "Capture : $outputFull (${width}x${height})"
