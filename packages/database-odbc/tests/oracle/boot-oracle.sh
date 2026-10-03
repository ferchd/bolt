#!/bin/bash
set -euo pipefail
: "${BOLT_ORACLE_TEST_PASSWORD:?Provide a disposable integration-test password}"
# Password is inserted into a quoted SQL identifier below.
if [[ "$BOLT_ORACLE_TEST_PASSWORD" == *\"* || "$BOLT_ORACLE_TEST_PASSWORD" == *$'\n'* || "$BOLT_ORACLE_TEST_PASSWORD" == *$'\r'* ]]; then
  echo 'Test password must not contain a double quote or newline' >&2; exit 1
fi
export ORACLE_HOME=/opt/oracle/product/26ai/dbhomeFree ORACLE_BASE=/opt/oracle ORACLE_SID=FREE
export LD_LIBRARY_PATH="$ORACLE_HOME/lib" PATH="$ORACLE_HOME/bin:$PATH" NLS_LANG=AMERICAN_AMERICA.AL32UTF8
groupadd -g 54321 dba
groupadd -g 54322 oinstall
useradd -u 54321 -g oinstall -G dba -d /opt/oracle -s /bin/bash oracle
mkdir -p /opt/oraInventory /opt/oracle/oradata
printf 'inventory_loc=/opt/oraInventory\ninst_group=oinstall\n' > /etc/oraInst.loc
touch /etc/oratab
chown -R oracle:oinstall /opt/oracle /opt/oraInventory /etc/oratab
chmod 664 /etc/oratab
chmod 6751 "$ORACLE_HOME/bin/oracle"
chown root:oinstall "$ORACLE_HOME/bin/oradism"
chmod 4750 "$ORACLE_HOME/bin/oradism"
runuser -u oracle -- bash "$ORACLE_HOME/bin/netca" -silent -responseFile "$ORACLE_HOME/assistants/netca/netca.rsp"
runuser -u oracle -- bash "$ORACLE_HOME/bin/dbca" -silent -createDatabase \
  -templateName FREE_Database.dbc -characterSet AL32UTF8 -createAsContainerDatabase true \
  -numberOfPDBs 1 -pdbName FREEPDB1 -sid FREE -gdbName FREE -totalMemory 1536 \
  -datafileDestination /opt/oracle/oradata -J-Doracle.assistants.dbca.validate.DBCredentials=false \
  -ignorePrereqs -J-Doracle.assistants.skipAvailableSharedMemoryCheck=true -skipDatapatch true \
  -sysPassword "$BOLT_ORACLE_TEST_PASSWORD" -systemPassword "$BOLT_ORACLE_TEST_PASSWORD" \
  -pdbAdminPassword "$BOLT_ORACLE_TEST_PASSWORD"
runuser -u oracle -- sqlplus -s / as sysdba <<SQL
SET DEFINE OFF
WHENEVER SQLERROR EXIT FAILURE
ALTER SESSION SET CONTAINER=FREEPDB1;
CREATE USER bolt IDENTIFIED BY "$BOLT_ORACLE_TEST_PASSWORD";
GRANT CREATE SESSION, CREATE TABLE, CREATE TRIGGER, CREATE SEQUENCE TO bolt;
ALTER USER bolt QUOTA UNLIMITED ON USERS;
GRANT EXECUTE ON SYS.DBMS_LOCK TO bolt;
ALTER PLUGGABLE DATABASE FREEPDB1 SAVE STATE;
EXIT
SQL
echo BOLT_ORACLE_READY
exec sleep infinity
