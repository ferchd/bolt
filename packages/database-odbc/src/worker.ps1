# Original Bolt ODBC protocol worker. Only stdin/stdout carry protocol data.
# Provider messages are intentionally excluded: they may contain SQL or credentials.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$connection = $null
$transaction = $null
$dialect = ''
$isolation = [System.Data.IsolationLevel]::ReadCommitted
$commandTimeout = 30
$maxRows = 50000
$maxResponseBytes = 33554432
$closeRequested = $false
$preserveDateStrings = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')

function Send-Frame($frame) {
    $json = ConvertTo-Json -InputObject $frame -Depth 20 -Compress
    if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt $script:maxResponseBytes) {
        $json = ConvertTo-Json -InputObject @{ id = $frame.id; ok = $false; code = 'response_too_large'; fatal = $true } -Compress
        $script:closeRequested = $true
    }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Reset-Session {
    if ($null -ne $script:transaction) {
        try { $script:transaction.Rollback() } finally {
            $script:transaction.Dispose()
            $script:transaction = $null
        }
    }
    $script:isolation = [System.Data.IsolationLevel]::ReadCommitted
}

function Close-Connection {
    try { Reset-Session } finally {
        if ($null -ne $script:connection) { $script:connection.Dispose(); $script:connection = $null }
    }
}

function Begin-Transaction {
    $script:transaction = $script:connection.BeginTransaction($script:isolation)
    if ($script:dialect -eq 'mssql') {
        # ODBC disables autocommit lazily. A table-reading statement materializes
        # SQL Server's transaction before SAVE TRANSACTION can be the first call.
        $beginCommand = $script:connection.CreateCommand()
        try {
            $beginCommand.CommandText = 'SELECT TOP (0) object_id FROM sys.all_objects'
            $beginCommand.CommandTimeout = $script:commandTimeout
            $beginCommand.Transaction = $script:transaction
            [void]$beginCommand.ExecuteNonQuery()
        } finally { $beginCommand.Dispose() }
    }
}

function Encode-Field($reader, [int]$index) {
    $kind = $reader.GetFieldType($index)
    # Read decimals directly as driver text before IsDBNull/GetValue. GetDecimal
    # uses .NET Decimal (28 digits), while SQL decimal supports up to 38 digits.
    if ($kind -eq [decimal] -or $kind -eq [DateTime] -or $kind -eq [DateTimeOffset] -or $kind -eq [TimeSpan]) {
        try { $text = $reader.GetString($index) } catch {
            if ($reader.IsDBNull($index)) { return @{ type = 'null' } }
            throw
        }
        return @{ type = if ($kind -eq [decimal]) { 'decimal' } else { 'date' }; value = $text }
    }
    if ($reader.IsDBNull($index)) { return @{ type = 'null' } }
    $value = $reader.GetValue($index)
    if ($value -is [long] -or $value -is [System.UInt64]) { return @{ type = 'bigint'; value = $value.ToString($script:invariant) } }
    if ($value -is [byte[]]) { return @{ type = 'binary'; value = [Convert]::ToBase64String($value) } }
    # Full .NET precision and timezone semantics remain exact strings in JS.
    if ($value -is [DateTime] -or $value -is [DateTimeOffset]) { return @{ type = 'date'; value = $value.ToString('o', $script:invariant) } }
    if ($value -is [TimeSpan]) { return @{ type = 'string'; value = $value.ToString('c', $script:invariant) } }
    if ($value -is [bool]) { return @{ type = 'boolean'; value = $value } }
    if ($value -is [double] -or $value -is [single]) { return @{ type = 'number'; value = $value.ToString('R', $script:invariant) } }
    if ($value -is [int] -or $value -is [System.Int16] -or $value -is [byte]) { return @{ type = 'number'; value = $value.ToString($script:invariant) } }
    return @{ type = 'string'; value = [string]$value }
}

function Add-Parameter($command, $wire) {
    $parameter = New-Object System.Data.Odbc.OdbcParameter
    switch ([string]$wire.type) {
        'null' { $parameter.OdbcType = [System.Data.Odbc.OdbcType]::NVarChar; $parameter.Value = [DBNull]::Value }
        'string' {
            $parameter.OdbcType = [System.Data.Odbc.OdbcType]::NVarChar
            $parameter.Value = [string]$wire.value
            $parameter.Size = [Math]::Max(1, $parameter.Value.Length)
        }
        'boolean' { $parameter.OdbcType = [System.Data.Odbc.OdbcType]::Bit; $parameter.Value = [bool]$wire.value }
        'bigint' {
            $parameter.OdbcType = [System.Data.Odbc.OdbcType]::BigInt
            $parameter.Value = [long]::Parse([string]$wire.value, $script:invariant)
        }
        'number' {
            $number = [double]::Parse([string]$wire.value, $script:invariant)
            if ($number -eq [Math]::Truncate($number)) {
                if ($number -ge [int]::MinValue -and $number -le [int]::MaxValue) {
                    $parameter.OdbcType = [System.Data.Odbc.OdbcType]::Int; $parameter.Value = [int]$number
                } else {
                    $parameter.OdbcType = [System.Data.Odbc.OdbcType]::BigInt; $parameter.Value = [long]$number
                }
            } else {
                $parameter.OdbcType = [System.Data.Odbc.OdbcType]::Double; $parameter.Value = $number
            }
        }
        'date' {
            $parameter.OdbcType = [System.Data.Odbc.OdbcType]::DateTime
            $parameter.Value = [DateTime]::Parse([string]$wire.value, $script:invariant, [System.Globalization.DateTimeStyles]::RoundtripKind)
        }
        'binary' {
            $parameter.OdbcType = [System.Data.Odbc.OdbcType]::VarBinary
            $parameter.Value = [Convert]::FromBase64String([string]$wire.value)
            $parameter.Size = [Math]::Max(1, $parameter.Value.Length)
        }
        default { throw 'Unsupported protocol parameter type' }
    }
    [void]$command.Parameters.Add($parameter)
}

function Add-OutputParameter($command, $wire) {
    $parameter = New-Object System.Data.Odbc.OdbcParameter
    $parameter.Direction = [System.Data.ParameterDirection]::Output
    $parameter.Size = [int]$wire.size
    switch ([string]$wire.outputType) {
        'binary' { $parameter.OdbcType = [System.Data.Odbc.OdbcType]::VarBinary }
        'number' { $parameter.OdbcType = [System.Data.Odbc.OdbcType]::Double }
        # Oracle NUMBER can exceed .NET Decimal and must be retrieved as text.
        default { $parameter.OdbcType = [System.Data.Odbc.OdbcType]::NVarChar }
    }
    [void]$command.Parameters.Add($parameter)
}

function Encode-Output($parameter, $wire) {
    $value = $parameter.Value
    if ($null -eq $value -or $value -is [DBNull]) { return @{ type = 'null' } }
    switch ([string]$wire.outputType) {
        'binary' { return @{ type = 'binary'; value = [Convert]::ToBase64String([byte[]]$value) } }
        'number' { return @{ type = 'number'; value = ([double]$value).ToString('R', $script:invariant) } }
        default { return @{ type = [string]$wire.outputType; value = [string]$value } }
    }
}

try {
    # .NET and Windows ODBC are platform facilities, no downloaded JS/.NET package.
    try { Add-Type -AssemblyName System.Data.Odbc } catch {
        # Windows PowerShell/.NET Framework ships ODBC in System.Data.dll.
        Add-Type -AssemblyName System.Data
    }
    while (-not $closeRequested) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $request = $null
        try {
            if ($preserveDateStrings) { $request = ConvertFrom-Json -InputObject $line -DateKind String }
            else {
                $request = ConvertFrom-Json -InputObject $line
                if ($PSVersionTable.PSVersion.Major -ge 6) {
                    Send-Frame @{ id = $request.id; ok = $false; code = 'unsupported_powershell'; fatal = $true }
                    break
                }
            }
            switch ([string]$request.operation) {
                'open' {
                    if ($null -ne $connection) { throw 'Connection already open' }
                    $dialect = [string]$request.dialect
                    # Oracle's default client charset can be US7ASCII. Wide ODBC
                    # bindings still pass CHAR expressions through this charset;
                    # use a Unicode charset and deterministic numeric formatting.
                    if ($dialect -eq 'oracle') { $env:NLS_LANG = 'AMERICAN_AMERICA.AL32UTF8' }
                    $commandTimeout = [int]$request.commandTimeout
                    $maxRows = [int]$request.maxRows
                    $maxResponseBytes = [int]$request.maxResponseBytes
                    $connection = New-Object System.Data.Odbc.OdbcConnection([string]$request.connectionString)
                    $connection.Open()
                    # A leaked connection string is never sent back to the parent.
                    $request = [PSCustomObject]@{ id = $request.id; operation = 'open' }
                    Send-Frame @{ id = $request.id; ok = $true }
                }
                'execute' {
                    if ($null -eq $connection -or $connection.State -ne [System.Data.ConnectionState]::Open) { throw 'Connection is not open' }
                    $sql = [string]$request.sql
                    $control = $sql.Trim().TrimEnd(';').Trim()
                    $handled = $true
                    if ($control -match '^SET TRANSACTION ISOLATION LEVEL (READ UNCOMMITTED|READ COMMITTED|REPEATABLE READ|SERIALIZABLE)$') {
                        if ($null -ne $transaction -or $request.parameters.Count -ne 0) { throw 'Invalid transaction control' }
                        switch ($Matches[1].ToUpperInvariant()) {
                            'READ UNCOMMITTED' { $isolation = [System.Data.IsolationLevel]::ReadUncommitted }
                            'READ COMMITTED' { $isolation = [System.Data.IsolationLevel]::ReadCommitted }
                            'REPEATABLE READ' { $isolation = [System.Data.IsolationLevel]::RepeatableRead }
                            'SERIALIZABLE' { $isolation = [System.Data.IsolationLevel]::Serializable }
                        }
                        if ($dialect -eq 'oracle') {
                            if ($isolation -ne [System.Data.IsolationLevel]::ReadCommitted -and $isolation -ne [System.Data.IsolationLevel]::Serializable) { throw 'Unsupported Oracle isolation' }
                            Begin-Transaction
                        }
                    } elseif ($control -match '^BEGIN( TRAN(SACTION)?)?$') {
                        if ($null -ne $transaction -or $request.parameters.Count -ne 0) { throw 'Invalid transaction control' }
                        Begin-Transaction
                    } elseif ($control -match '^(COMMIT|ROLLBACK)( TRAN(SACTION)?)?$') {
                        if ($null -eq $transaction -or $request.parameters.Count -ne 0) { throw 'No active transaction' }
                        try {
                            if ($Matches[1].ToUpperInvariant() -eq 'COMMIT') { $transaction.Commit() } else { $transaction.Rollback() }
                        } finally { $transaction.Dispose(); $transaction = $null }
                    } else { $handled = $false }
                    if ($handled) { Send-Frame @{ id = $request.id; ok = $true; rows = @(); affectedRows = 0 }; break }
                    $command = $connection.CreateCommand()
                    $reader = $null
                    try {
                        $command.CommandText = $sql
                        $command.CommandTimeout = $commandTimeout
                        if ($null -ne $transaction) { $command.Transaction = $transaction }
                        $outputBindings = New-Object 'System.Collections.Generic.List[object]'
                        foreach ($wire in $request.parameters) {
                            if ($wire.type -eq 'output') {
                                $ordinal = $command.Parameters.Count
                                Add-OutputParameter $command $wire
                                $outputBindings.Add(@{ ordinal = $ordinal; wire = $wire })
                            } else { Add-Parameter $command $wire }
                        }
                        if ($outputBindings.Count -gt 0) {
                            $affectedRows = [Math]::Max(0, $command.ExecuteNonQuery())
                            $outputValues = New-Object object[] $outputBindings.Count
                            foreach ($binding in $outputBindings) { $outputValues[[int]$binding.wire.index] = Encode-Output $command.Parameters[[int]$binding.ordinal] $binding.wire }
                            Send-Frame @{ id = $request.id; ok = $true; rows = @(); affectedRows = $affectedRows; output = @($outputValues) }
                            break
                        }
                        $reader = $command.ExecuteReader()
                        $rows = New-Object 'System.Collections.Generic.List[object]'
                        $rowBytes = 0
                        do {
                            # SqlResult represents one rowset. Multiple non-empty rowsets
                            # are rejected instead of silently merging differing schemas.
                            $rowsetHasRows = $false
                            while ($reader.Read()) {
                                if ($rows.Count -ge $maxRows) { throw 'Result row limit exceeded' }
                                if (-not $rowsetHasRows -and $rows.Count -gt 0) { throw 'Multiple result sets are unsupported' }
                                $rowsetHasRows = $true
                                $row = @{}
                                for ($index = 0; $index -lt $reader.FieldCount; $index++) {
                                    $name = $reader.GetName($index)
                                    if ($row.ContainsKey($name)) { throw 'Duplicate result column; use explicit aliases' }
                                    $row[$name] = Encode-Field $reader $index
                                }
                                $rowJson = ConvertTo-Json -InputObject $row -Depth 10 -Compress
                                $rowBytes += [System.Text.Encoding]::UTF8.GetByteCount($rowJson)
                                if ($rowBytes -gt $maxResponseBytes - 1024) { throw 'Result byte limit exceeded' }
                                $rows.Add($row)
                            }
                        } while ($reader.NextResult())
                        $affectedRows = [Math]::Max(0, $reader.RecordsAffected)
                        $reader.Close()
                        Send-Frame @{ id = $request.id; ok = $true; rows = @($rows.ToArray()); affectedRows = $affectedRows }
                    } finally {
                        if ($null -ne $reader) { $reader.Dispose() }
                        $command.Dispose()
                    }
                }
                'reset' { Reset-Session; Send-Frame @{ id = $request.id; ok = $true } }
                'close' { Close-Connection; Send-Frame @{ id = $request.id; ok = $true }; $closeRequested = $true }
                default { throw 'Unsupported protocol operation' }
            }
        } catch {
            $exception = $_.Exception
            while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
            $failure = @{ id = if ($null -ne $request) { $request.id } else { 0 }; ok = $false; code = 'provider_error'; fatal = ($null -eq $connection -or $connection.State -ne [System.Data.ConnectionState]::Open) }
            if ($exception -is [System.Data.Odbc.OdbcException] -and $exception.Errors.Count -gt 0) {
                $failure.sqlState = $exception.Errors[0].SQLState
                $failure.nativeCode = $exception.Errors[0].NativeError
            }
            Send-Frame $failure
            if ($failure.fatal) { $closeRequested = $true }
        }
    }
} finally {
    try { Close-Connection } catch { # Process termination also closes native handles.
    }
}
