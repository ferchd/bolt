# Oracle native integration harness

Prefer Oracle's supported Database Free container and supported host platform.
This compatibility harness reproduces the test environment used when Oracle's
container CDN was inaccessible: the official Oracle Free RPM on an available
Microsoft Ubuntu 22.04 container base. It is disposable test infrastructure,
not a certified Oracle production deployment. It starts no SQL Server process.

Download native vendor artifacts to a scratch directory outside the repository:

| Artifact | Source | SHA-256 |
| --- | --- | --- |
| `oracle-free.rpm` | [Oracle Free 26ai 23.26.3 EL8 RPM](https://download.oracle.com/otn-pub/otn_software/db-free/oracle-ai-database-free-26ai-23.26.3-1.el8.x86_64.rpm) | `879eb7ffc9c8c797dafc42974afaff7714c4069b27cc4adc0827291244f05d97` |
| `libaio.deb` | [Ubuntu libaio1](https://archive.ubuntu.com/ubuntu/pool/main/liba/libaio/libaio1_0.3.112-13build1_amd64.deb) | `2dcfe0b49d7cccfbf1bd6a3f627cf44bea9f51fb32f7e0e552a0df75698e0d27` |
| Instant Client Basic Windows x64 23.26.3 | [Oracle Basic ZIP](https://download.oracle.com/otn_software/nt/instantclient/2326300/instantclient-basic-windows.x64-23.26.3.0.0.zip) | `4c7fe8a77f6b9a00d57214ffda241f14f79dad5774a8f53073b7497e54b51763` |
| Instant Client ODBC Windows x64 23.26.3 | [Oracle ODBC ZIP](https://download.oracle.com/otn_software/nt/instantclient/2326300/instantclient-odbc-windows.x64-23.26.3.0.0.zip) | `ba99284ae9ef01288395aa82d1f5f219aa8b75e2b266d9c8d5a3ab2f81ea9f37` |

Check each checksum before use. Copy this directory's Dockerfile, Python extractor
and shell script into that scratch directory. The extractor uses Python's standard
library and the pinned trusted RPM; it is a build helper, not a general untrusted
archive service. Preserve LF line endings for the shell script.

```powershell
docker build --tag bolt-oracle-native-test $oracleScratch
# Set a disposable password in this process; it is never committed.
docker run --detach --init --name bolt-test-oracle-native --memory 4g --shm-size 1g `
  --publish 127.0.0.1::1521 --env "BOLT_ORACLE_TEST_PASSWORD=$env:BOLT_ORACLE_TEST_PASSWORD" `
  bolt-oracle-native-test
docker logs --follow bolt-test-oracle-native
# Wait for BOLT_ORACLE_READY, then inspect the published port.
docker port bolt-test-oracle-native 1521
```

The initialization creates `FREEPDB1` and the `bolt` test account with schema
creation privileges, unlimited quota on USERS and EXECUTE on SYS.DBMS_LOCK.
Never grant this test account to an application production deployment. Container
storage is disposable; no host database volume is mounted. Create a new container
for each run rather than restarting the initializer.

Extract both Windows Instant Client ZIPs into the same scratch folder. Provision
an Oracle ODBC DSN using Oracle's supported driver configuration. When administrator
registration is unavailable, the real tests used a private current-user DSN:

```powershell
$oracleDsnName = 'Bolt_Oracle_23_26_test'
$oracleDsnKey = "HKCU:\Software\ODBC\ODBC.INI\$oracleDsnName"
# Choose an unused name; do not overwrite an existing DSN.
if (Test-Path -LiteralPath $oracleDsnKey) { throw 'DSN already exists' }
New-Item -Path $oracleDsnKey -Force | Out-Null
New-ItemProperty -LiteralPath $oracleDsnKey -Name Driver -Value "$oracleClient\sqora32.dll" | Out-Null
New-ItemProperty -LiteralPath $oracleDsnKey -Name ServerName -Value "127.0.0.1:$oraclePort/FREEPDB1" | Out-Null
$oracleSourcesKey = 'HKCU:\Software\ODBC\ODBC.INI\ODBC Data Sources'
New-Item -Path $oracleSourcesKey -Force | Out-Null
New-ItemProperty -LiteralPath $oracleSourcesKey -Name $oracleDsnName -Value 'Oracle in instantclient_23_26' | Out-Null
$env:PATH = "$oracleClient;$env:PATH" # Process only; do not alter global PATH.
$env:BOLT_TEST_ORACLE_ODBC_CONNECTION = "DSN=$oracleDsnName;DBQ=127.0.0.1:$oraclePort/FREEPDB1;UID=bolt;PWD=$env:BOLT_ORACLE_TEST_PASSWORD"
bun test ./packages/database-odbc/tests/integration.test.ts ./packages/orm/tests/odbc-integration.test.ts ./packages/auth/tests/sql-integration.test.ts
```

Remove the disposable container and **only the exact DSN created for this test**
after all checks finish. Preserve other ODBC registrations and user data. Delete
the connection environment variable and discard the process PATH change. Native
client binaries and downloaded RPM/DEB artifacts stay outside Bolt's repository
and published packages. Oracle client also requires the corresponding Microsoft
Visual C++ runtime; follow [Oracle's current native client prerequisites](https://www.oracle.com/database/technologies/instant-client/winx64-64-downloads.html).
