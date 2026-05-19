#!/usr/bin/env python3
"""
Club ETL v2 — с курсором last_synced_at.

Собирает посты пользователя из systemsworld.club (Discourse)
и формирует markdown-чанки для индексации в personal-knowledge-mcp.

v2 changes:
- Поддержка cursor (last_synced_at) — загружает только новые/изменённые посты
- Курсор хранится в cursor-файле (JSON)

Usage:
    python3 club-etl.py --username tseren-tserenov --output club-export/ [--cursor-file .club-cursor]
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx

CLUB_BASE = "https://systemsworld.club"
API_KEY = os.getenv("DISCOURSE_API_KEY", "")
RATE_LIMIT_SLEEP = 1.0
MAX_RETRIES = 3


class ClubETL:
    def __init__(self, api_key: str, output_dir: Path, cursor_file: Path | None):
        self.api_key = api_key
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.client = httpx.AsyncClient(timeout=30)
        self.cursor_file = cursor_file
        self.last_synced_at = self._load_cursor()

    def _load_cursor(self) -> str | None:
        if self.cursor_file and self.cursor_file.exists():
            data = json.loads(self.cursor_file.read_text())
            return data.get("last_synced_at")
        return None

    def _save_cursor(self, latest: str) -> None:
        if self.cursor_file:
            self.cursor_file.write_text(json.dumps({"last_synced_at": latest}, indent=2))

    def _headers(self) -> dict:
        return {
            "Api-Key": self.api_key,
            "Api-Username": "Aisystant",
        }

    async def _get(self, url: str) -> dict:
        for attempt in range(MAX_RETRIES):
            try:
                resp = await self.client.get(url, headers=self._headers())
                resp.raise_for_status()
                await asyncio.sleep(RATE_LIMIT_SLEEP)
                return resp.json()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429:
                    wait = 2 ** attempt
                    print(f"  429 Too Many Requests — retry in {wait}s (attempt {attempt + 1}/{MAX_RETRIES})")
                    await asyncio.sleep(wait)
                    continue
                raise
        raise RuntimeError(f"Failed after {MAX_RETRIES} retries: {url}")

    async def get_user_topics(self, username: str) -> list[dict]:
        url = f"{CLUB_BASE}/topics/created-by/{username}.json"
        data = await self._get(url)
        topics = data.get("topic_list", {}).get("topics", [])
        # Фильтруем по cursor
        if self.last_synced_at:
            filtered = [
                t for t in topics
                if t.get("last_posted_at", "") > self.last_synced_at
            ]
            print(f"Cursor {self.last_synced_at}: {len(topics)} topics → {len(filtered)} new/updated")
            return filtered
        return topics

    async def get_topic(self, topic_id: int) -> dict:
        url = f"{CLUB_BASE}/t/{topic_id}.json"
        return await self._get(url)

    async def get_post(self, post_id: int) -> dict:
        url = f"{CLUB_BASE}/posts/{post_id}.json"
        return await self._get(url)

    async def export_user(self, username: str) -> dict:
        topics = await self.get_user_topics(username)
        print(f"Found {len(topics)} topics for {username}")

        exported = {
            "username": username,
            "topics_count": len(topics),
            "posts_count": 0,
            "files": [],
        }
        latest_sync = self.last_synced_at or "1970-01-01T00:00:00.000Z"

        for topic in topics:
            topic_id = topic["id"]
            topic_data = await self.get_topic(topic_id)
            posts = topic_data.get("post_stream", {}).get("posts", [])

            for post in posts:
                if post.get("username") != username:
                    continue

                post_id = post["id"]
                post_data = await self.get_post(post_id)
                raw = post_data.get("raw", "")
                if not raw.strip():
                    continue

                created_at = post_data.get("created_at", "")
                if created_at > latest_sync:
                    latest_sync = created_at

                title = topic_data.get("title", "Untitled")
                content = f"""---
title: "{title}"
source: systemsworld.club
post_id: {post_id}
topic_id: {topic_id}
author: {username}
created_at: {created_at}
---

# {title}

{raw}
"""
                filename = f"{topic_id}-{post_id}.md"
                filepath = self.output_dir / filename
                filepath.write_text(content, encoding="utf-8")

                exported["posts_count"] += 1
                exported["files"].append(str(filepath))
                print(f"  Exported: {filename} ({len(raw)} chars)")

        # Save manifest
        manifest_path = self.output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(exported, ensure_ascii=False, indent=2))
        print(f"\nManifest: {manifest_path}")
        print(f"Total posts exported: {exported['posts_count']}")

        # Save cursor
        if exported["posts_count"] > 0:
            self._save_cursor(latest_sync)
            print(f"Cursor updated: {latest_sync}")

        return exported

    async def close(self):
        await self.client.aclose()


async def main():
    parser = argparse.ArgumentParser(description="Club ETL v2")
    parser.add_argument("--username", default="tseren-tserenov", help="Discourse username")
    parser.add_argument("--output", default="club-export", help="Output directory")
    parser.add_argument("--cursor-file", default=".club-cursor", help="Cursor file path")
    args = parser.parse_args()

    if not API_KEY:
        print("ERROR: Set DISCOURSE_API_KEY env var", file=sys.stderr)
        sys.exit(1)

    etl = ClubETL(API_KEY, Path(args.output), Path(args.cursor_file))
    try:
        await etl.export_user(args.username)
    finally:
        await etl.close()


if __name__ == "__main__":
    asyncio.run(main())
