$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$transaction = $false
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $request = ConvertFrom-Json -InputObject $line -DateKind String }
    else { $request = ConvertFrom-Json -InputObject $line }
    $frame = @{ id = $request.id; ok = $true }
    switch ($request.operation) {
        'open' { }
        'reset' { $transaction = $false }
        'close' { }
        'execute' {
            if ($request.sql -eq 'crash') { exit 19 }
            if ($request.sql -eq 'hang') { Start-Sleep -Milliseconds 2000 }
            if ($request.sql -eq 'badframe') { [Console]::Out.WriteLine('{"id":0,"ok":true}'); [Console]::Out.Flush(); continue }
            if ($request.sql -eq 'provider_error') {
                $frame.ok = $false; $frame.code = 'provider_error'; $frame.sqlState = '42000'; $frame.nativeCode = 42
                $frame.message = 'secret password must never leave worker'
            } else {
                if ($request.sql -eq 'BEGIN') { $transaction = $true }
                if ($request.sql -eq 'COMMIT' -or $request.sql -eq 'ROLLBACK') { $transaction = $false }
                $row = @{ pid = @{ type = 'number'; value = [string]$PID }; sql = @{ type = 'string'; value = $request.sql }; transaction = @{ type = 'boolean'; value = $transaction } }
                $index = 0
                $output = @()
                foreach ($parameter in $request.parameters) {
                    if ($parameter.type -eq 'output') { $output += @{ type = $parameter.outputType; value = '12345678901234567890123456789012345678' } }
                    else { $row["p$index"] = $parameter; $index++ }
                }
                $row.exactDecimal = @{ type = 'decimal'; value = '12345678901234567890123456789012345678' }
                $frame.rows = @($row); $frame.affectedRows = 0
                $frame.output = @($output)
            }
        }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $frame -Depth 12 -Compress))
    [Console]::Out.Flush()
    if ($request.operation -eq 'close') { break }
}
