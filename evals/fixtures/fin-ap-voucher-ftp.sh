#!/bin/sh
# fin_ap_vchr_send.sh - Send the AP voucher interface file to the bank
# Created by: Margaret Okafor
# 2017-06-30  Margaret Okafor  Initial
# 2022-01-12  mokafor          New bank gateway
BANK_HOST=bankgw.firstmeridian.com
BANK_USER=apvend01
BANK_PASS='Vnd!xfer2024'
FILE=/psoft/fin/outbound/ap_voucher.txt

if [ ! -f $FILE ]; then
  echo "voucher file missing"
  exit 1
fi

ftp -n $BANK_HOST <<END_FTP
user $BANK_USER $BANK_PASS
ascii
cd /incoming/ap
put $FILE ap_voucher.txt
quit
END_FTP
if [ $? -ne 0 ]; then
  echo "ftp failed" | mailx -s "AP voucher transfer failed" margaret.okafor@northwind-hr.com
  exit 6
fi
echo "AP voucher file sent"
exit 0
