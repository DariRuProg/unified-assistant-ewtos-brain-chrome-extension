"""Video-Transcript + Summary. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from tools import summary_writer
from tools import transcript_writer


router = APIRouter()

# --- Videos: Transcript + Summary ---------------------------------------

class TranscriptSaveRequest(BaseModel):
    transcript: str
    with_timestamps: bool = False


@router.post("/tools/videos/{vault_id}/{slug}/transcript")
def videos_save_transcript(
    vault_id: str,
    slug: str,
    req: TranscriptSaveRequest,
    saeule: str | None = None,
) -> dict[str, Any]:
    try:
        return transcript_writer.save_transcript(
            vault_id, slug, req.transcript, req.with_timestamps, saeule=saeule,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tools/videos/{vault_id}/{slug}/summary")
def videos_generate_summary(vault_id: str, slug: str, saeule: str | None = None) -> dict[str, Any]:
    try:
        return summary_writer.generate_summary(vault_id, slug, saeule=saeule)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
