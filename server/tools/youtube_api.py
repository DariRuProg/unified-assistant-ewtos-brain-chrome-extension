"""YouTube Data API v3 Wrapper — cachend, quota-bewusst.

Wird vom Briefing-Tool fuer Sources `youtube_trending`, `competitor_videos`
und `playlist_trending` genutzt.
"""
from __future__ import annotations

__author__ = "Dario | ewtos.com"

import time
from datetime import datetime
from typing import Any

import httpx

import settings

BASE_URL = "https://www.googleapis.com/youtube/v3"
CACHE_TTL_SECONDS = 600
QUOTA_LIMIT = 9000

_cache: dict[tuple, tuple[float, Any]] = {}
_quota_used = 0


class YouTubeAPIError(Exception):
    pass


def _api_key() -> str:
    key = settings.get("youtube_api_key")
    if not key:
        raise YouTubeAPIError("YOUTUBE_API_KEY nicht gesetzt")
    return key


def _check_quota(cost: int) -> None:
    global _quota_used
    if _quota_used + cost > QUOTA_LIMIT:
        raise YouTubeAPIError(
            "Quota fast aufgebraucht — Briefing-Source wird uebersprungen"
        )


def _bump_quota(cost: int) -> None:
    global _quota_used
    _quota_used += cost


def _cache_get(key: tuple) -> Any | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.time() - ts > CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return value


def _cache_put(key: tuple, value: Any) -> None:
    _cache[key] = (time.time(), value)


def _hashable_params(params: dict) -> frozenset:
    return frozenset((k, v) for k, v in params.items())


async def _get(endpoint: str, params: dict, *, quota_cost: int) -> dict:
    cache_key = (endpoint, _hashable_params(params))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    _check_quota(quota_cost)

    full_params = dict(params)
    full_params["key"] = _api_key()

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{BASE_URL}/{endpoint}", params=full_params)
        if r.status_code >= 400:
            raise YouTubeAPIError(
                f"YouTube API {endpoint} HTTP {r.status_code}: {r.text[:200]}"
            )
        data = r.json()

    _bump_quota(quota_cost)
    _cache_put(cache_key, data)
    return data


def _thumb(snippet: dict) -> str:
    thumbs = snippet.get("thumbnails") or {}
    for key in ("medium", "high", "default", "standard", "maxres"):
        t = thumbs.get(key)
        if t and t.get("url"):
            return t["url"]
    return ""


def _channel_uploads_playlist_id(channel_id: str) -> str:
    # UC... → UU... (zweites Zeichen wird zu 'U')
    if not channel_id or len(channel_id) < 2:
        return channel_id
    return channel_id[0] + "U" + channel_id[2:]


async def search_videos(
    query: str,
    *,
    published_after: datetime | None = None,
    max_results: int = 10,
    order: str = "viewCount",
) -> list[dict]:
    params: dict[str, Any] = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": max(1, min(50, max_results)),
        "order": order,
    }
    if published_after:
        params["publishedAfter"] = (
            published_after.isoformat().replace("+00:00", "Z")
            if "T" in published_after.isoformat()
            else published_after.isoformat() + "T00:00:00Z"
        )

    data = await _get("search", params, quota_cost=100)
    items = []
    for it in data.get("items") or []:
        vid = (it.get("id") or {}).get("videoId")
        sn = it.get("snippet") or {}
        if not vid:
            continue
        items.append({
            "video_id": vid,
            "title": sn.get("title", ""),
            "channel_id": sn.get("channelId", ""),
            "channel_title": sn.get("channelTitle", ""),
            "published_at": sn.get("publishedAt", ""),
            "thumbnail_url": _thumb(sn),
            "description": sn.get("description", ""),
        })
    return items


async def get_video_stats(video_ids: list[str]) -> dict[str, dict]:
    if not video_ids:
        return {}

    result: dict[str, dict] = {}
    # videos.list erlaubt bis 50 IDs pro Call
    for chunk_start in range(0, len(video_ids), 50):
        chunk = video_ids[chunk_start:chunk_start + 50]
        params = {
            "part": "statistics,snippet,contentDetails",
            "id": ",".join(chunk),
        }
        # cost = 1 + (parts - 1) * 2 = 1 + 2*2 = 5
        data = await _get("videos", params, quota_cost=5)
        for it in data.get("items") or []:
            vid = it.get("id")
            if not vid:
                continue
            stats = it.get("statistics") or {}
            sn = it.get("snippet") or {}
            cd = it.get("contentDetails") or {}
            result[vid] = {
                "views": int(stats.get("viewCount", 0) or 0),
                "likes": int(stats.get("likeCount", 0) or 0),
                "comments": int(stats.get("commentCount", 0) or 0),
                "duration": cd.get("duration", ""),
                "tags": list(sn.get("tags") or []),
                "title": sn.get("title", ""),
                "channel_title": sn.get("channelTitle", ""),
                "channel_id": sn.get("channelId", ""),
                "published_at": sn.get("publishedAt", ""),
                "thumbnail_url": _thumb(sn),
            }
    return result


async def get_channel_uploads(
    channel_id: str,
    *,
    max_results: int = 10,
    published_after: datetime | None = None,
) -> list[dict]:
    playlist_id = _channel_uploads_playlist_id(channel_id)
    params = {
        "part": "snippet,contentDetails",
        "playlistId": playlist_id,
        "maxResults": max(1, min(50, max_results)),
    }
    data = await _get("playlistItems", params, quota_cost=1)

    items = []
    for it in data.get("items") or []:
        sn = it.get("snippet") or {}
        cd = it.get("contentDetails") or {}
        vid = cd.get("videoId") or (sn.get("resourceId") or {}).get("videoId")
        if not vid:
            continue
        published_at = cd.get("videoPublishedAt") or sn.get("publishedAt", "")
        if published_after and published_at:
            try:
                pa = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                if pa.replace(tzinfo=None) < published_after.replace(tzinfo=None):
                    continue
            except Exception:
                pass
        items.append({
            "video_id": vid,
            "title": sn.get("title", ""),
            "channel_id": sn.get("channelId", ""),
            "channel_title": sn.get("channelTitle", ""),
            "published_at": published_at,
            "thumbnail_url": _thumb(sn),
            "description": sn.get("description", ""),
        })
    return items
