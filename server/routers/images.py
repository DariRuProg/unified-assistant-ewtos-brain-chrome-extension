"""Image-Generator + Galerie Endpoints. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from tools import image_generator as image_generator_tool

router = APIRouter()

# --- Image-Generator (Gemini Nano Banana) --------------------------------

class ImageGenRequest(BaseModel):
    prompt: str
    input_images: list[str] = []  # base64-Strings oder data-URLs
    input_files: list[str] = []   # relative Pfade in generated_images/
    model: str | None = None      # None -> Setting/Default


@router.post("/tools/image_generate")
def image_generate_endpoint(req: ImageGenRequest) -> dict[str, Any]:
    return image_generator_tool.generate_image(
        prompt=req.prompt,
        input_images=req.input_images,
        input_files=req.input_files,
        model=req.model,
    )


@router.get("/tools/image_gallery")
def image_gallery_list() -> dict[str, Any]:
    return {"items": image_generator_tool.list_index()}


@router.delete("/tools/image_gallery/{rel_path:path}")
def image_gallery_delete(rel_path: str) -> dict[str, Any]:
    try:
        return image_generator_tool.delete_entry(rel_path)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tools/image_gallery/open")
def image_gallery_open() -> dict[str, Any]:
    try:
        return image_generator_tool.open_output_folder()
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/tools/image_generated/{rel_path:path}")
def image_generated_serve(rel_path: str):
    from fastapi.responses import Response
    try:
        data, mime = image_generator_tool.read_generated_file(rel_path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return Response(content=data, media_type=mime)
