# OCR Recognition via Windows.Media.Ocr WinRT API
# Takes an image path, runs OCR, outputs JSON result to stdout.
# Called one-shot per OCR request (results cached in TypeScript layer).

param([string]$ImagePath)

# Force UTF-8 on stdout so non-ASCII recognized text (emoji, accented
# characters, CJK) survives the round-trip to Node. PowerShell defaults
# to the system code page; Node decodes as UTF-8.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

try {
    # Resolve to absolute path (required by WinRT StorageFile API)
    $ImagePath = (Resolve-Path $ImagePath -ErrorAction Stop).Path

    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]

    $asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethod -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.IsGenericType -and
        $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1

    if (-not $asTaskOp) {
        [Console]::Out.WriteLine('{"error":"Cannot find AsTask method for WinRT async"}')
        [Console]::Out.Flush()
        exit 0
    }

    function Invoke-Async {
        param([object]$AsyncOp, [Type]$ResultType)
        $genericMethod = $script:asTaskOp.MakeGenericMethod($ResultType)
        $task = $genericMethod.Invoke($null, @($AsyncOp))
        $task.Wait() | Out-Null
        return $task.Result
    }

    $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $ocr) {
        [Console]::Out.WriteLine('{"error":"Windows OCR engine not available - no recognized languages installed"}')
        [Console]::Out.Flush()
        exit 0
    }

    $storageFile = Invoke-Async ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream      = Invoke-Async ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder     = Invoke-Async ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap      = Invoke-Async ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $ocrResult = Invoke-Async ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $elements = @()
    $lineIdx = 0
    foreach ($line in $ocrResult.Lines) {
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            $elements += [PSCustomObject]@{
                text       = ($word.Text -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', '')
                x          = [math]::Round($r.X)
                y          = [math]::Round($r.Y)
                width      = [math]::Round($r.Width)
                height     = [math]::Round($r.Height)
                line       = $lineIdx   # no confidence: Windows.Media.Ocr has none, and an invented 1.0 read as certainty (#275)
            }
        }
        $lineIdx++
    }

    try { $stream.Dispose() } catch {}
    try { $bitmap.Dispose() } catch {}

    $output = [PSCustomObject]@{
        elements = @($elements)   # force array even if 0 or 1 element
        fullText = if ($ocrResult.Text) { $ocrResult.Text } else { "" }
    }
    [Console]::Out.WriteLine(($output | ConvertTo-Json -Depth 3 -Compress))
    [Console]::Out.Flush()

} catch {
    [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    exit 0
}
