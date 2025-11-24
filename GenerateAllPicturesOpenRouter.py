import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

from OpenRouterApi.open_router_client import OpenRouterError, generate_image_to_file


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Generate missing photos for story nodes using OpenRouter. "
            "Example: python GenerateAllPicturesOpenRouter.py -f Stories/NightOfMajor"
        )
    )
    parser.add_argument(
        "-f",
        "--folder",
        required=True,
        help="Path to story folder (e.g. Stories/NightOfMajor)",
    )
    parser.add_argument(
        "--aspect",
        default="9:16",
        help="Aspect ratio for generated images (default: 9:16)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="OpenRouter model to use (overrides config.py default)",
    )
    return parser.parse_args(argv)


def _iter_node_files(story_dir: Path):
    nodes_dir = story_dir / "Nodes"
    if not nodes_dir.is_dir():
        raise SystemExit(f"Story folder '{story_dir}' does not contain 'Nodes' directory")

    return sorted(nodes_dir.glob("*.json"), key=lambda p: p.name)


async def process_story(story_dir: Path, aspect: str = "9:16", model: str = None) -> int:
    photos_dir = story_dir / "Photos"
    photos_dir.mkdir(parents=True, exist_ok=True)

    total_generated = 0

    for node_path in _iter_node_files(story_dir):
        try:
            with node_path.open("r", encoding="utf-8") as f:
                node = json.load(f)
        except json.JSONDecodeError as e:
            print(f"[WARN] Failed to parse JSON '{node_path}': {e}", file=sys.stderr)
            continue

        messages = node.get("messages")
        if not isinstance(messages, list):
            continue

        node_id = node.get("id")
        changed = False

        for msg_index, msg in enumerate(messages):
            if not isinstance(msg, dict):
                continue
            if msg.get("type") != "photo":
                continue

            desc_raw = msg.get("photo_description")
            desc = str(desc_raw).strip() if desc_raw is not None else ""
            has_description = bool(desc)

            file_val = msg.get("photo_file")
            has_file = isinstance(file_val, str) and file_val.strip() != ""

            if not has_description or has_file:
                continue

            print(
                f"[OpenRouter] Generating image for node {node_id} "
                f"({node_path.name}), message index {msg_index}"
            )

            try:
                image_path = await generate_image_to_file(
                    prompt=desc,
                    aspect=aspect,
                    extension="png",
                    model=model
                )
            except OpenRouterError as e:
                print(
                    f"[OpenRouter] Error while generating image for node {node_id}, "
                    f"message {msg_index}: {e}",
                    file=sys.stderr,
                )
                continue
            except Exception as e:
                print(
                    f"[OpenRouter] Unexpected error while generating image for node {node_id}, "
                    f"message {msg_index}: {e}",
                    file=sys.stderr,
                )
                continue

            image_path = Path(image_path)
            if not image_path.is_file():
                print(
                    f"[OpenRouter] Generated file not found on disk: {image_path}",
                    file=sys.stderr,
                )
                continue

            target_path = photos_dir / image_path.name

            try:
                shutil.copy2(image_path, target_path)
            except Exception as e:
                print(
                    f"[OpenRouter] Failed to copy image to Photos directory for node {node_id}, "
                    f"message {msg_index}: {e}",
                    file=sys.stderr,
                )
                continue

            msg["photo_file"] = target_path.name
            changed = True
            total_generated += 1

            print(
                f"[OpenRouter] photo_file set to '{target_path.name}' "
                f"for node {node_id}, message {msg_index}"
            )

        if changed:
            try:
                with node_path.open("w", encoding="utf-8") as f:
                    json.dump(node, f, ensure_ascii=False, indent=4)
                print(f"[OpenRouter] Node {node_id} saved ({node_path.name})")
            except Exception as e:
                print(
                    f"[OpenRouter] Failed to save updated node file '{node_path}': {e}",
                    file=sys.stderr,
                )

    return total_generated


def main(argv=None) -> int:
    args = parse_args(argv)

    story_dir = Path(args.folder).expanduser()
    if not story_dir.is_dir():
        print(
            f"Error: story folder '{story_dir}' does not exist or is not a directory",
            file=sys.stderr,
        )
        return 1

    try:
        total_generated = asyncio.run(process_story(story_dir, aspect=args.aspect, model=args.model))
    except KeyboardInterrupt:
        print("\nInterrupted by user", file=sys.stderr)
        return 1

    print(f"[OpenRouter] Done. Generated {total_generated} image(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
