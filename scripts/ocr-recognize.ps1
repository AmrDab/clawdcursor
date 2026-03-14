# OCR Recognition via Windows.Media.Ocr WinRT API
# Takes an image path, runs OCR, outputs JSON result to stdout.
# Called one-shot per OCR request (results cached in TypeScript layer).

param([string]$ImagePath)

try {
    # Resolve to absolute path (required by WinRT StorageFile API)
    $ImagePath = (Resolve-Path $ImagePath -ErrorAction Stop).Path

    # Load WinRT interop assembly
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    # Load WinRT types
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]

    # Find the AsTask<TResult>(IAsyncOperation<TResult>) extension method
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

    # Create OCR engine from user profile languages
    $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $ocr) {
        [Console]::Out.WriteLine('{"error":"Windows OCR engine not available - no recognized languages installed"}')
        [Console]::Out.Flush()
        exit 0
    }

    # Open image via WinRT StorageFile → stream → BitmapDecoder → SoftwareBitmap
    $storageFile = Invoke-Async ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream      = Invoke-Async ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder     = Invoke-Async ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap      = Invoke-Async ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    # Run OCR recognition
    $ocrResult = Invoke-Async ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    # Build structured result — one entry per word with bounding box
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
                confidence = 1.0   # Windows.Media.Ocr does not expose per-word confidence
                line       = $lineIdx
            }
        }
        $lineIdx++
    }

    # Clean up WinRT resources
    try { $stream.Dispose() } catch {}
    try { $bitmap.Dispose() } catch {}

    # Output single-line JSON
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
