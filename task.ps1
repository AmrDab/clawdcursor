param([string]$t = "Press the Windows key")
Invoke-WebRequest -Uri "http://127.0.0.1:3847/task" -Method POST -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @{task=$t}))) | Select-Object -ExpandProperty Content
