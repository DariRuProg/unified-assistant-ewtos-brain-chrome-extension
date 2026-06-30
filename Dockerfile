# EwtosBrain Server — Container-Image für Coolify / Docker (Hetzner etc.)
# @author Dario | ewtos.com
#
# Baut nur den Python-Server (FastAPI + WebSocket). Die Chrome-Extension wird NICHT
# mit ausgeliefert — die kommt aus dem Chrome Web Store und verbindet sich gegen
# die hier gehostete Server-URL.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    EWTOS_HOST=0.0.0.0 \
    EWTOS_PORT=9988 \
    XDG_DATA_HOME=/data

WORKDIR /app

# Erst nur die Requirements kopieren → Docker-Layer-Cache nutzt das bei Code-Änderungen.
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install -r /app/server/requirements.txt

# Server-Code (inkl. demo_vault/) ins Image.
COPY server /app/server

# Schreibbares Datenverzeichnis (settings.json, Chats, Logs). In Coolify als
# Persistent Storage auf /data mounten, damit es Deploys übersteht.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 9988

WORKDIR /app/server
CMD ["python", "main.py"]
