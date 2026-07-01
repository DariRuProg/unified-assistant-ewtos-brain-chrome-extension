"""Video-Transcript + Summary. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import licensing
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
) -> dict[str, Any]:
    try:
        return transcript_writer.save_transcript(
            vault_id, slug, req.transcript, req.with_timestamps,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tools/videos/{vault_id}/{slug}/summary",
             dependencies=[Depends(licensing.require_pro)])
def videos_generate_summary(vault_id: str, slug: str) -> dict[str, Any]:
    try:
        return summary_writer.generate_summary(vault_id, slug)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
