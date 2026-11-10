#!/bin/ksh
# pii_mess.sh
# Author: Margaret Okafor
# Contact: Okafor, Margaret <margaret.okafor@northwind-hr.com> tel 415-555-0142 or (415) 555-0142
# Reviewed by: R. Venkataraman
# 14-MAR-2021  Margaret Okafor : added SSN lookup for 521-44-9031
# Owner: rvenkat
EMPLID=0045127
OPRID="MOKAFOR"
cd /home/mokafor/work
cp ~rvenkat/templates/base.sql /tmp/base.sql
sqlplus -s sysadm/Summ3r#Payroll@HCMPRD <<EOF
SELECT EMPLID FROM PS_PERSONAL_DATA
 WHERE NATIONAL_ID = '521-44-9031'
    OR NAME = 'Okafor,Margaret'
    OR BIRTHDATE = TO_DATE('1984-07-23','YYYY-MM-DD')
    OR ADDRESS1 = '1420 Larkspur Lane'
    OR PHONE = '415/555-0142'
    OR OPRID IN ('MOKAFOR', 'RVENKAT')
    OR EMPLID = '0045127';
EOF
curl -s -u apvend01:Vnd!xfer2024 https://bankgw.firstmeridian.com/api/ping
echo "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtb2thZm9yIn0.c2lnbmF0dXJlMTIzNDU2"
scp /tmp/x.dat nwpayxfer@10.44.12.7:/in/
mount -t nfs pshcmprd01.northwind-hr.com:/export/psoft /mnt/psoft
exit 0
