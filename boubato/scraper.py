#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
棒バトトピックサイト データ収集スクリプト
- ニコニコ動画: 「棒バトランキングYYYY」タグ (2021〜) をスナップショット検索API v2で取得
- YouTube: Data API v3 でキーワード検索 (環境変数 YOUTUBE_API_KEY が必要)
- Twitter(X): 公式APIが有料のため現状は検索リンクのみ（後で差し替え可能）

出力: docs/data/topics.json

使い方:
    python scraper.py                # 全ソース取得
    YOUTUBE_API_KEY=xxx python scraper.py
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

# ----------------------------------------------------------------------------
# 設定
# ----------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT / "docs" / "data" / "topics.json"

JST = dt.timezone(dt.timedelta(hours=9), "JST")

# ニコニコ: 取得対象の年。最初の年〜今年まで自動で広げる。
NICO_START_YEAR = 2021
NICO_END_YEAR = dt.datetime.now(JST).year
# 各年の上位件数（再生数順）
NICO_PER_YEAR = 20
# 全体「新着」に出す件数
NICO_RECENT_LIMIT = 24

NICO_ENDPOINT = (
    "https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search"
)
NICO_UA = "boubato-topic-site/1.0 (https://github.com/)"
NICO_FIELDS = (
    "contentId,title,viewCounter,commentCounter,mylistCounter,"
    "likeCounter,thumbnailUrl,startTime,lengthSeconds,tags"
)

# YouTube: 検索キーワード。複数指定すると結合・重複排除される。
YOUTUBE_QUERIES = ["棒バト", "棒人間バトル", "棒バトランキング"]
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
YOUTUBE_RECENT_LIMIT = 24
YOUTUBE_POPULAR_LIMIT = 12

# Twitter(X) 検索リンク（自動取得は未対応）
TWITTER_QUERY = "棒バト OR 棒人間バトル"


# ----------------------------------------------------------------------------
# ニコニコ
# ----------------------------------------------------------------------------
def nico_search(params: dict[str, Any]) -> list[dict[str, Any]]:
    """スナップショット検索APIを1回叩いて data を返す。"""
    base = {
        "fields": NICO_FIELDS,
        "_context": "boubato-topic-site",
    }
    base.update(params)
    resp = requests.get(
        NICO_ENDPOINT, params=base, headers={"User-Agent": NICO_UA}, timeout=30
    )
    resp.raise_for_status()
    payload = resp.json()
    status = payload.get("meta", {}).get("status")
    if status != 200:
        raise RuntimeError(f"Niconico API returned meta.status={status}: {payload}")
    return payload.get("data", [])


def nico_normalize(item: dict[str, Any], year: int | None = None) -> dict[str, Any]:
    cid = item.get("contentId", "")
    return {
        "id": cid,
        "title": html.unescape(item.get("title", "")),
        "url": f"https://www.nicovideo.jp/watch/{cid}",
        "thumbnail": item.get("thumbnailUrl", ""),
        "views": item.get("viewCounter", 0) or 0,
        "comments": item.get("commentCounter", 0) or 0,
        "mylists": item.get("mylistCounter", 0) or 0,
        "likes": item.get("likeCounter", 0) or 0,
        "length_seconds": item.get("lengthSeconds", 0) or 0,
        "posted_at": item.get("startTime", ""),
        "tags": html.unescape(item.get("tags", "")),
        "year": year,
        "source": "niconico",
    }


def fetch_niconico() -> dict[str, Any]:
    years: dict[str, list[dict[str, Any]]] = {}
    recent_pool: list[dict[str, Any]] = []

    for year in range(NICO_START_YEAR, NICO_END_YEAR + 1):
        tag = f"棒バトランキング{year}"
        try:
            # 再生数ランキング
            top = nico_search(
                {
                    "q": tag,
                    "targets": "tagsExact",
                    "_sort": "-viewCounter",
                    "_limit": NICO_PER_YEAR,
                }
            )
            years[str(year)] = [nico_normalize(x, year) for x in top]
            time.sleep(0.6)  # レート制御（前回応答時間相当の間隔）

            # 新着（投稿日時順）— 全体の新着プールに投入
            newest = nico_search(
                {
                    "q": tag,
                    "targets": "tagsExact",
                    "_sort": "-startTime",
                    "_limit": 12,
                }
            )
            recent_pool.extend(nico_normalize(x, year) for x in newest)
            time.sleep(0.6)
            print(f"[niconico] {tag}: top={len(top)} newest={len(newest)}")
        except Exception as e:  # noqa: BLE001
            print(f"[niconico] {tag} 取得失敗: {e}", file=sys.stderr)

    # 新着を投稿日時降順で重複排除
    seen: set[str] = set()
    recent_pool.sort(key=lambda x: x["posted_at"], reverse=True)
    recent: list[dict[str, Any]] = []
    for item in recent_pool:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        recent.append(item)
        if len(recent) >= NICO_RECENT_LIMIT:
            break

    return {"years": years, "recent": recent}


# ----------------------------------------------------------------------------
# YouTube
# ----------------------------------------------------------------------------
def yt_get(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    params = {**params, "key": YOUTUBE_API_KEY}
    resp = requests.get(
        f"https://www.googleapis.com/youtube/v3/{endpoint}", params=params, timeout=30
    )
    resp.raise_for_status()
    return resp.json()


def fetch_youtube() -> dict[str, Any]:
    if not YOUTUBE_API_KEY:
        print("[youtube] YOUTUBE_API_KEY 未設定のためスキップ", file=sys.stderr)
        return {"enabled": False, "recent": [], "popular": []}

    video_ids: list[str] = []
    seen: set[str] = set()
    for query in YOUTUBE_QUERIES:
        try:
            data = yt_get(
                "search",
                {
                    "part": "snippet",
                    "q": query,
                    "type": "video",
                    "order": "date",
                    "maxResults": 25,
                    "relevanceLanguage": "ja",
                    "regionCode": "JP",
                },
            )
            for item in data.get("items", []):
                vid = item.get("id", {}).get("videoId")
                if vid and vid not in seen:
                    seen.add(vid)
                    video_ids.append(vid)
            print(f"[youtube] query='{query}' -> {len(data.get('items', []))}件")
            time.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            print(f"[youtube] 検索失敗 query='{query}': {e}", file=sys.stderr)

    if not video_ids:
        return {"enabled": True, "recent": [], "popular": []}

    # 動画詳細（再生数・公開日など）をまとめて取得（最大50件/回）
    videos: list[dict[str, Any]] = []
    for i in range(0, len(video_ids), 50):
        chunk = video_ids[i : i + 50]
        try:
            data = yt_get(
                "videos",
                {"part": "snippet,statistics", "id": ",".join(chunk)},
            )
            for item in data.get("items", []):
                videos.append(yt_normalize(item))
            time.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            print(f"[youtube] 詳細取得失敗: {e}", file=sys.stderr)

    recent = sorted(videos, key=lambda x: x["posted_at"], reverse=True)[
        :YOUTUBE_RECENT_LIMIT
    ]
    popular = sorted(videos, key=lambda x: x["views"], reverse=True)[
        :YOUTUBE_POPULAR_LIMIT
    ]
    return {"enabled": True, "recent": recent, "popular": popular}


def yt_normalize(item: dict[str, Any]) -> dict[str, Any]:
    vid = item.get("id", "")
    sn = item.get("snippet", {})
    st = item.get("statistics", {})
    thumbs = sn.get("thumbnails", {})
    thumb = (
        thumbs.get("medium", {}).get("url")
        or thumbs.get("high", {}).get("url")
        or thumbs.get("default", {}).get("url", "")
    )
    return {
        "id": vid,
        "title": sn.get("title", ""),
        "url": f"https://www.youtube.com/watch?v={vid}",
        "thumbnail": thumb,
        "channel": sn.get("channelTitle", ""),
        "views": int(st.get("viewCount", 0) or 0),
        "likes": int(st.get("likeCount", 0) or 0),
        "posted_at": sn.get("publishedAt", ""),
        "source": "youtube",
    }


# ----------------------------------------------------------------------------
# Twitter (placeholder)
# ----------------------------------------------------------------------------
def fetch_twitter() -> dict[str, Any]:
    q = requests.utils.quote(TWITTER_QUERY)
    return {
        "enabled": False,
        "query": TWITTER_QUERY,
        "search_url": f"https://twitter.com/search?q={q}&f=live",
        "items": [],
    }


# ----------------------------------------------------------------------------
# メイン
# ----------------------------------------------------------------------------
def load_existing() -> dict[str, Any]:
    try:
        with OUTPUT_PATH.open(encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def main() -> int:
    print("=== 棒バトトピック収集開始 ===")
    previous = load_existing()

    niconico = fetch_niconico()
    youtube = fetch_youtube()
    twitter = fetch_twitter()

    # 取得失敗時のデータ保護: 今回が空で前回にデータがあれば前回を温存。
    # （例: 実行環境のIPがニコニコ/CloudFrontにブロックされた場合など）
    nico_total = sum(len(v) for v in niconico["years"].values())
    if nico_total == 0 and previous.get("niconico", {}).get("years"):
        print("[guard] ニコニコ取得0件 → 前回データを温存", file=sys.stderr)
        niconico = previous["niconico"]

    if (
        not youtube.get("recent")
        and previous.get("youtube", {}).get("recent")
    ):
        # YouTubeが今回空でも、キー未設定でない限り前回を温存
        if youtube.get("enabled"):
            print("[guard] YouTube取得0件 → 前回データを温存", file=sys.stderr)
            youtube = previous["youtube"]

    result = {
        "updated_at": dt.datetime.now(JST).isoformat(timespec="seconds"),
        "niconico": niconico,
        "youtube": youtube,
        "twitter": twitter,
        "meta": {
            "nico_year_range": [NICO_START_YEAR, NICO_END_YEAR],
        },
    }

    # データが空でも、既存ファイルが壊れないよう一旦書き込み判断
    nico_count = sum(len(v) for v in niconico["years"].values())
    print(
        f"=== 収集結果: niconico={nico_count}件 / "
        f"youtube={len(youtube['recent'])}件 ==="
    )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"書き込み完了: {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
