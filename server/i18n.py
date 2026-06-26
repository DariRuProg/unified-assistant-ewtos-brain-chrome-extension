"""Server-side i18n — error messages and user-facing strings. ewtos.com"""
from __future__ import annotations

import settings

_MESSAGES: dict[str, dict[str, str]] = {
    "en": {
        # Vault
        "err.vault_not_found": "Vault not found: {id}",
        "err.vault_not_found_plain": "Vault not found",
        "err.vault_path_missing": "Vault path missing",
        "err.vault_path_not_found": "Vault path not found: {path}",
        "err.vault_already_exists": "Vault already exists: {name}",
        "err.vault_required": "vault_id required",
        "err.vault_name_empty": "Name must not be empty",
        "err.vault_path_empty": "Path must not be empty",
        "err.vault_no_claude_md": "No CLAUDE.md found in path or its parent",
        # Files
        "err.file_not_found": "File not found: {path}",
        "err.file_read_error": "File could not be read: {path}",
        "err.file_write_error": "File could not be written: {path}",
        "err.file_delete_error": "File could not be deleted: {path}",
        "err.path_outside_vault": "Path is outside vault: {path}",
        "err.path_not_markdown": "Only .md files are supported",
        "err.folder_not_empty": "Folder is not empty: {path}",
        # Permissions
        "err.write_permission_denied": "Write permission not enabled for this vault. Enable in options.",
        "err.raw_write_denied": "Write permission for raw/ not enabled. Enable in options.",
        "err.files_write_denied": "write_files permission not enabled. Enable in vault settings.",
        "err.raw_ingest_denied": "write_raw permission for this vault not enabled.",
        "err.playlists_permission_denied": "Playlists permission not enabled. Enable in options.",
        "err.files_permission_denied": "File management permission not enabled. Enable in options.",
        # Content
        "err.transcript_required": "Transcript required",
        "err.url_required": "URL required",
        "err.title_required": "Title required",
        "err.tts_text_missing": "text is missing",
        "err.search_query_empty": "Search query must not be empty",
        "err.no_content": "No content found",
        "err.no_text_extractable": "No text could be extracted.",
        "err.content_too_short": "Content too short (< {min} chars)",
        "err.filetype_unsupported": "Unsupported file type: {mime}",
        # Connectivity
        "err.connection_error": "Connection error: {message}",
        "err.api_error": "API error: {message}",
        "err.timeout": "Request timed out",
        "err.invalid_json": "Invalid JSON",
        # Settings
        "err.settings_key_not_editable": "Setting '{key}' is not editable",
        "err.settings_key_unknown": "Unknown setting: {key}",
        # Bookmarks
        "err.bookmark_not_found": "Bookmark not found",
        "err.bookmark_required": "match (URL or title) is required",
        "err.bookmark_url_empty": "URL must not be empty",
        "err.bookmark_url_invalid": "URL must start with http:// or https://, not: {url}",
        "err.bookmark_match_empty": "match must not be empty",
        "err.bookmark_ambiguous": "Multiple bookmarks match '{match}': {preview} — be more specific.",
        # Blueprints
        "err.blueprint_not_found": "Blueprint not found: {id}",
        "err.blueprint_not_found_plain": "Blueprint not found",
        "err.blueprint_invalid": "Invalid blueprint: {reason}",
        "err.blueprint_import_failed": "Blueprint import failed: {reason}",
        "err.blueprint_unsigned": "Blueprint is not signed by a trusted publisher. Import anyway?",
        "err.blueprint_commit_failed": "Blueprint commit failed: {reason}",
        "err.blueprint_url_import_not_supported": "URL import not yet implemented — please send JSON body.",
        "err.blueprint_body_required": "Body requires 'blueprint' object",
        "err.blueprint_builtin_delete_denied": "Built-in blueprints cannot be deleted",
        "err.blueprint_imported_not_found": "Imported blueprint not found",
        "err.blueprint_no_snapshot": "No blueprint snapshot available",
        # LLM
        "err.model_not_set": "No LLM model configured",
        "err.api_key_missing": "API key not set for provider: {provider}",
        "err.provider_unknown": "Unknown LLM provider: {provider}",
        "err.summary_failed": "Summary generation failed: {error}",
        # Promote
        "err.promote_title_required": "Title is required for promote",
        "err.promote_permission_denied": "Promote permission not enabled. Enable write_raw in options.",
        "err.promote_subfolder_invalid": "Invalid target subfolder: {subfolder}",
        # PDF
        "err.pdf_not_found": "PDF file not found: {path}",
        "err.pdf_read_error": "PDF could not be read: {path}",
        # Images
        "err.image_prompt_required": "Image prompt required",
        "err.image_gen_failed": "Image generation failed: {error}",
        "err.gemini_key_missing": "Gemini API key not set",
        # Briefing
        "err.briefing_profile_not_found": "Briefing profile not found: {id}",
        "err.briefing_failed": "Briefing generation failed: {error}",
        "err.youtube_api_key_missing": "YouTube API key not set",
        # Playlists
        "err.playlist_not_found": "Playlist not found: {id}",
        "err.playlist_video_not_found": "Video not found in playlist",
        # Todos / Notes
        "err.todo_not_found": "Todo not found: {match}",
        "err.todo_ambiguous": "Multiple todos match '{match}' — be more specific",
        "err.todo_ambiguous_matches": "Multiple matches for '{match}': {preview} — be more specific or use exact text",
        "err.todo_text_empty": "Todo text must not be empty",
        "err.todo_match_empty": "match_text must not be empty",
        "err.todo_action_invalid": "action must be complete|uncomplete|delete, not: {action}",
        "err.text_empty": "Text must not be empty",
        "err.export_path_empty": "Path is empty",
        "err.export_type_invalid": "Only .md or .txt allowed, not {suffix}",
        "err.notes_path_not_set": "Notes path not configured. Set in options.",
        "err.notes_path_not_found": "Notes path not found: {path}",
        # Health / Upgrade
        "err.health_check_failed": "Health check failed: {error}",
        "err.upgrade_diff_failed": "Diff generation failed: {error}",
        "err.upgrade_apply_failed": "Apply failed: {error}",
        "err.repair_failed": "Repair failed: {error}",
        # Web tools
        "err.scrape_failed": "Scrape failed: {error}",
        "err.seo_check_failed": "SEO check failed: {error}",
        # Version
        "err.version_mismatch": "Extension/Server version mismatch — please reload",
        # Setup agent
        "err.setup_session_not_found": "Setup session not found: {id}",
        "err.setup_agent_failed": "Setup agent failed: {error}",
        # video-brain
        "err.supabase_not_configured": "Supabase not configured. Set URL and keys in options.",
        "err.license_invalid": "License key invalid or expired",
        "err.sync_failed": "Sync failed: {error}",
    },
    "de": {
        # Vault
        "err.vault_not_found": "Vault nicht gefunden: {id}",
        "err.vault_not_found_plain": "Vault nicht gefunden",
        "err.vault_path_missing": "Vault-Pfad fehlt",
        "err.vault_path_not_found": "Vault-Pfad nicht gefunden: {path}",
        "err.vault_already_exists": "Vault existiert bereits: {name}",
        "err.vault_required": "vault_id erforderlich",
        "err.vault_name_empty": "Name darf nicht leer sein",
        "err.vault_path_empty": "Pfad darf nicht leer sein",
        "err.vault_no_claude_md": "Keine CLAUDE.md im Pfad oder dessen Parent gefunden",
        # Files
        "err.file_not_found": "Datei nicht gefunden: {path}",
        "err.file_read_error": "Datei konnte nicht gelesen werden: {path}",
        "err.file_write_error": "Datei konnte nicht geschrieben werden: {path}",
        "err.file_delete_error": "Datei konnte nicht gelöscht werden: {path}",
        "err.path_outside_vault": "Pfad liegt außerhalb des Vaults: {path}",
        "err.path_not_markdown": "Nur .md-Dateien werden unterstützt",
        "err.folder_not_empty": "Ordner ist nicht leer: {path}",
        # Permissions
        "err.write_permission_denied": "Schreibberechtigung für diesen Vault nicht aktiviert. In Einstellungen aktivieren.",
        "err.raw_write_denied": "Schreibberechtigung für raw/ nicht aktiviert. In Einstellungen aktivieren.",
        "err.files_write_denied": "write_files-Permission nicht aktiviert. In Einstellungen → Vault bearbeiten aktivieren.",
        "err.raw_ingest_denied": "write_raw-Permission für diesen Vault nicht aktiviert.",
        "err.playlists_permission_denied": "Playlists-Berechtigung nicht aktiviert. In Einstellungen aktivieren.",
        "err.files_permission_denied": "Datei-Verwaltungsberechtigung nicht aktiviert. In Einstellungen aktivieren.",
        # Content
        "err.transcript_required": "Transcript erforderlich",
        "err.url_required": "URL erforderlich",
        "err.title_required": "Titel erforderlich",
        "err.tts_text_missing": "text fehlt",
        "err.search_query_empty": "Suchbegriff darf nicht leer sein",
        "err.no_content": "Kein Inhalt gefunden",
        "err.no_text_extractable": "Kein Text extrahierbar.",
        "err.content_too_short": "Inhalt zu kurz (< {min} Zeichen)",
        "err.filetype_unsupported": "Nicht unterstützter Dateityp: {mime}",
        # Connectivity
        "err.connection_error": "Verbindungsfehler: {message}",
        "err.api_error": "API-Fehler: {message}",
        "err.timeout": "Anfrage hat zu lange gedauert",
        "err.invalid_json": "Ungültiges JSON",
        # Settings
        "err.settings_key_not_editable": "Einstellung '{key}' ist nicht bearbeitbar",
        "err.settings_key_unknown": "Unbekannte Einstellung: {key}",
        # Bookmarks
        "err.bookmark_not_found": "Bookmark nicht gefunden",
        "err.bookmark_required": "match (URL oder Titel) ist erforderlich",
        "err.bookmark_url_empty": "URL darf nicht leer sein",
        "err.bookmark_url_invalid": "URL muss mit http:// oder https:// beginnen, nicht: {url}",
        "err.bookmark_match_empty": "match darf nicht leer sein",
        "err.bookmark_ambiguous": "Mehrere Bookmarks matchen '{match}': {preview} — bitte präziser.",
        # Blueprints
        "err.blueprint_not_found": "Blueprint nicht gefunden: {id}",
        "err.blueprint_not_found_plain": "Blueprint nicht gefunden",
        "err.blueprint_invalid": "Ungültiger Blueprint: {reason}",
        "err.blueprint_import_failed": "Blueprint-Import fehlgeschlagen: {reason}",
        "err.blueprint_unsigned": "Blueprint ist nicht von einem vertrauenswürdigen Herausgeber signiert. Trotzdem importieren?",
        "err.blueprint_commit_failed": "Blueprint-Commit fehlgeschlagen: {reason}",
        "err.blueprint_url_import_not_supported": "URL-Import noch nicht implementiert — bitte JSON-Body senden.",
        "err.blueprint_body_required": "Body braucht 'blueprint'-Objekt",
        "err.blueprint_builtin_delete_denied": "Built-in Blueprints können nicht gelöscht werden",
        "err.blueprint_imported_not_found": "Importierter Blueprint nicht gefunden",
        "err.blueprint_no_snapshot": "Kein Blueprint-Snapshot vorhanden",
        # LLM
        "err.model_not_set": "Kein LLM-Modell konfiguriert",
        "err.api_key_missing": "API-Key für Provider nicht gesetzt: {provider}",
        "err.provider_unknown": "Unbekannter LLM-Provider: {provider}",
        "err.summary_failed": "Zusammenfassungs-Generierung fehlgeschlagen: {error}",
        # Promote
        "err.promote_title_required": "Titel für Promote erforderlich",
        "err.promote_permission_denied": "Promote-Berechtigung nicht aktiviert. write_raw in Einstellungen aktivieren.",
        "err.promote_subfolder_invalid": "Ungültiger Ziel-Unterordner: {subfolder}",
        # PDF
        "err.pdf_not_found": "PDF-Datei nicht gefunden: {path}",
        "err.pdf_read_error": "PDF konnte nicht gelesen werden: {path}",
        # Images
        "err.image_prompt_required": "Bild-Prompt erforderlich",
        "err.image_gen_failed": "Bild-Generierung fehlgeschlagen: {error}",
        "err.gemini_key_missing": "Gemini-API-Key nicht gesetzt",
        # Briefing
        "err.briefing_profile_not_found": "Briefing-Profil nicht gefunden: {id}",
        "err.briefing_failed": "Briefing-Generierung fehlgeschlagen: {error}",
        "err.youtube_api_key_missing": "YouTube-API-Key nicht gesetzt",
        # Playlists
        "err.playlist_not_found": "Playlist nicht gefunden: {id}",
        "err.playlist_video_not_found": "Video nicht in Playlist gefunden",
        # Todos / Notes
        "err.todo_not_found": "Todo nicht gefunden: {match}",
        "err.todo_ambiguous": "Mehrere Todos treffen '{match}' — bitte genauer angeben",
        "err.todo_ambiguous_matches": "Mehrere Treffer für '{match}': {preview} — bitte präziser oder eindeutiger Text",
        "err.todo_text_empty": "Todo-Text darf nicht leer sein",
        "err.todo_match_empty": "match_text darf nicht leer sein",
        "err.todo_action_invalid": "action muss complete|uncomplete|delete sein, nicht: {action}",
        "err.text_empty": "Text darf nicht leer sein",
        "err.export_path_empty": "Pfad ist leer",
        "err.export_type_invalid": "Nur .md oder .txt erlaubt, nicht {suffix}",
        "err.notes_path_not_set": "Notizen-Pfad nicht konfiguriert. In Einstellungen setzen.",
        "err.notes_path_not_found": "Notizen-Pfad nicht gefunden: {path}",
        # Health / Upgrade
        "err.health_check_failed": "Gesundheitscheck fehlgeschlagen: {error}",
        "err.upgrade_diff_failed": "Diff-Generierung fehlgeschlagen: {error}",
        "err.upgrade_apply_failed": "Anwenden fehlgeschlagen: {error}",
        "err.repair_failed": "Reparatur fehlgeschlagen: {error}",
        # Web tools
        "err.scrape_failed": "Scrape fehlgeschlagen: {error}",
        "err.seo_check_failed": "SEO-Check fehlgeschlagen: {error}",
        # Version
        "err.version_mismatch": "Extension/Server-Versionen stimmen nicht überein — bitte neu laden",
        # Setup agent
        "err.setup_session_not_found": "Setup-Session nicht gefunden: {id}",
        "err.setup_agent_failed": "Setup-Agent fehlgeschlagen: {error}",
        # video-brain
        "err.supabase_not_configured": "Supabase nicht konfiguriert. URL und Keys in Einstellungen setzen.",
        "err.license_invalid": "Lizenz-Key ungültig oder abgelaufen",
        "err.sync_failed": "Sync fehlgeschlagen: {error}",
    },
    "it": {},
    "es": {},
}

_LANG_NAMES = {
    "en": "English",
    "de": "Deutsch",
    "it": "Italiano",
    "es": "Español",
}


def _current_lang() -> str:
    lang = settings.get("ui_language", "en")
    return lang if lang in _MESSAGES else "en"


def t(key: str, lang: str | None = None, **kw: object) -> str:
    if lang is None:
        lang = _current_lang()
    catalog = _MESSAGES.get(lang, {})
    msg = catalog.get(key) or _MESSAGES["en"].get(key) or key
    for k, v in kw.items():
        msg = msg.replace("{" + k + "}", str(v))
    return msg


def lang_name(lang: str | None = None) -> str:
    if lang is None:
        lang = _current_lang()
    return _LANG_NAMES.get(lang, "English")
