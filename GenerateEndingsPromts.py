import os
import json
import argparse
from collections import deque


def load_nodes(story_folder):
    nodes_dir = os.path.join(story_folder, "Nodes")
    nodes = {}
    if not os.path.isdir(nodes_dir):
        raise ValueError("Nodes directory not found: %s" % nodes_dir)
    for name in os.listdir(nodes_dir):
        if not name.lower().endswith(".json"):
            continue
        path = os.path.join(nodes_dir, name)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        node_id = data.get("id")
        if isinstance(node_id, int):
            nodes[node_id] = data
    if not nodes:
        raise ValueError("No node JSON files found in %s" % nodes_dir)
    return nodes


def build_parent_map(nodes):
    referenced = set()
    for node in nodes.values():
        answers = node.get("answers") or []
        for ans in answers:
            nxt = ans.get("next_node")
            if isinstance(nxt, int):
                referenced.add(nxt)
    roots = [nid for nid in nodes.keys() if nid not in referenced]
    roots.sort()
    if not roots and nodes:
        roots = [sorted(nodes.keys())[0]]
    parent = {}
    queue = deque()
    for r in roots:
        parent[r] = None
        queue.append(r)
    while queue:
        current = queue.popleft()
        node = nodes.get(current) or {}
        answers = node.get("answers") or []
        for ans in answers:
            nxt = ans.get("next_node")
            if not isinstance(nxt, int):
                continue
            if nxt not in parent:
                parent[nxt] = current
                queue.append(nxt)
    return parent, roots


def reconstruct_chain(story_folder, node_id):
    nodes = load_nodes(story_folder)
    if node_id not in nodes:
        raise ValueError("Node id %s not found" % node_id)
    parent, roots = build_parent_map(nodes)
    chain = []
    current = node_id
    visited = set()
    while True:
        chain.append(current)
        visited.add(current)
        parent_id = parent.get(current)
        if parent_id is None or parent_id in visited:
            break
        current = parent_id
    chain.reverse()
    return chain


def extract_messages(node):
    result = []
    messages = node.get("messages") or []
    for msg in messages:
        for key in ("message", "photo_description", "photo_message", "video_description", "video_message"):
            value = msg.get(key)
            if isinstance(value, str) and value.strip():
                result.append(value)
    return result


def find_answer_message(node, next_id):
    answers = node.get("answers") or []
    for ans in answers:
        if ans.get("next_node") == next_id:
            text = ans.get("message")
            if isinstance(text, str):
                return text
    return None


def generate_endings_prompts(story_folder):
    nodes = load_nodes(story_folder)
    parent, roots = build_parent_map(nodes)
    leaf_ids = []
    for nid, node in nodes.items():
        answers = node.get("answers")
        if not answers:
            leaf_ids.append(nid)
    leaf_ids.sort()
    endings_dir = os.path.join(story_folder, "EndingsPromts")
    os.makedirs(endings_dir, exist_ok=True)
    for index, leaf_id in enumerate(leaf_ids, start=1):
        chain = []
        current = leaf_id
        visited = set()
        while True:
            chain.append(current)
            visited.add(current)
            parent_id = parent.get(current)
            if parent_id is None or parent_id in visited:
                break
            current = parent_id
        chain.reverse()
        simplified_nodes = []
        for i in range(len(chain) - 1):
            current_id = chain[i]
            next_id = chain[i + 1]
            node = nodes.get(current_id) or {}
            messages = extract_messages(node)
            answer_text = find_answer_message(node, next_id)
            simplified_nodes.append({"id": current_id, "messages": messages, "answer": answer_text})
        if chain:
            last_id = chain[-1]
            last_node = nodes.get(last_id) or {}
            last_messages = extract_messages(last_node)
            simplified_nodes.append({"id": last_id, "messages": last_messages, "answer": ""})
        output_path = os.path.join(endings_dir, f"{index}_{leaf_id}.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(simplified_nodes, f, ensure_ascii=False, indent=4)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-f", "--folder", required=True, help="Story folder, for example Stories/LastChance")
    args = parser.parse_args()
    story_folder = args.folder
    if not os.path.isabs(story_folder):
        story_folder = os.path.join(os.getcwd(), story_folder)
    generate_endings_prompts(story_folder)


if __name__ == "__main__":
    main()
