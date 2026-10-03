# Compatibility test harness only; this does not certify Oracle on Ubuntu.
# This exact vendor base was available when the Oracle registry CDN was unreachable.
FROM mcr.microsoft.com/mssql/server:2022-CU20-ubuntu-22.04
USER root
COPY oracle-free.rpm libaio.deb extract-rpm.py /tmp/
RUN echo '879eb7ffc9c8c797dafc42974afaff7714c4069b27cc4adc0827291244f05d97  /tmp/oracle-free.rpm' | sha256sum -c - \
 && echo '2dcfe0b49d7cccfbf1bd6a3f627cf44bea9f51fb32f7e0e552a0df75698e0d27  /tmp/libaio.deb' | sha256sum -c - \
 && dpkg -i /tmp/libaio.deb \
 && python3 /tmp/extract-rpm.py /tmp/oracle-free.rpm / \
 && rm /tmp/oracle-free.rpm /tmp/libaio.deb
COPY boot-oracle.sh /usr/local/bin/bolt-oracle-test
RUN sed -i 's/\r$//' /usr/local/bin/bolt-oracle-test
EXPOSE 1521
ENTRYPOINT ["bash", "/usr/local/bin/bolt-oracle-test"]
