"""Extract XMLTV channel IDs and names, without retaining programme data."""

import gzip
import io
import json
import sys
import xml.etree.ElementTree as ET

MAX_XML = 96 * 1024 * 1024
data = sys.stdin.buffer.read()
if data[:2] == b"\x1f\x8b":
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as archive:
        data = archive.read(MAX_XML + 1)
if len(data) > MAX_XML or b"<!ENTITY" in data:
    raise ValueError("Unsupported XMLTV input")

root = None
channels = {}
depth = 0
for event, element in ET.iterparse(io.BytesIO(data), events=("start", "end")):
    if event == "start":
        depth += 1
        if root is None:
            root = element
            if root.tag != "tv":
                raise ValueError("Missing XMLTV tv element")
    else:
        if depth == 2 and element.tag == "channel":
            channel_id = element.get("id")
            if channel_id:
                names = [name.text.strip() for name in element.findall("display-name") if name.text]
                channels[channel_id] = names[0] if names else channel_id
        if depth == 2:
            root.remove(element)
        depth -= 1
if not channels:
    raise ValueError("No XMLTV channels")
json.dump([{"id": key, "name": value} for key, value in channels.items()], sys.stdout)
