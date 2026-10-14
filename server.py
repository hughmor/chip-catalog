#!/usr/bin/env python3
"""Chip catalog server: a web GDS/OASIS viewer with chip records and wafer maps.

All lab data lives in one catalog directory (see README.md):
  gds/        layout files (.gds, .gds2, .oas); one file is one chip
  tech/       KLayout layer properties, <technology>.lyp
  wafermaps/  wafer map templates, <name>.json
  chips/      chip records, <chip id>.json (the server makes these)
  config.json optional: title and die statuses

Run: .venv/bin/python server.py --catalog catalog [--host 0.0.0.0] [--port 8000]
"""
import argparse
import json
import os
import re
import threading
import uuid
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from klayout import db, lay

STATIC = Path(__file__).resolve().parent / "static"
LAYOUT_EXTS = {".gds", ".gds2", ".gdsii", ".oas"}
FIELDS = {"internal_name": "", "designation": "", "technology": "", "github": "",
          "authors": [], "notes": "", "run": ""}
DEFAULT_CONFIG = {
    "title": "Chip Catalog",
    # The first status is the status of a die with no record.
    "statuses": {"unknown": "#9e9e9e", "untested": "#4a90d9", "tested": "#3cb371",
                 "damaged": "#d9534f", "offsite": "#c58af9"},
}
MAX_BODY = 1 << 20
MAX_UPLOAD = 2 << 30
MAX_BOXES = 2000
BACKGROUNDS = {"dark": "#000000", "light": "#ffffff"}  # the page theme selects one
CATALOG = Path("catalog")
# ponytail: one lock for all KLayout calls and record writes. Use per-chip locks if many users edit at once.
LOCK = threading.RLock()


# ---------- catalog files ----------

def config():
    f = CATALOG / "config.json"
    return {**DEFAULT_CONFIG, **(json.loads(f.read_text()) if f.exists() else {})}


def layouts():
    return {p.stem: p for p in sorted((CATALOG / "gds").iterdir()) if p.suffix.lower() in LAYOUT_EXTS}


def wafer_maps():
    return {p.stem: json.loads(p.read_text()) for p in sorted((CATALOG / "wafermaps").glob("*.json"))}


def map_labels(m):
    return [t for row in m["rows"] for t in row.split() if t != "."]


def techs():
    return {p.stem: p for p in sorted((CATALOG / "tech").glob("*.lyp"))}


def lyp_for(tech):
    """Layer properties for a technology name (case-insensitive), or None for KLayout default colours."""
    return next((str(p) for name, p in techs().items() if tech and name.lower() == tech.lower()), None)


def load_chip(cid):
    path = layouts()[cid]  # KeyError -> 404, and only known ids reach the file system
    f = CATALOG / "chips" / f"{cid}.json"
    chip = {**FIELDS, "internal_name": cid, "wafers": [], **(json.loads(f.read_text()) if f.exists() else {})}
    chip.update(id=cid, file=path.name, mtime=int(path.stat().st_mtime))
    return chip


def save_chip(chip):
    data = {k: v for k, v in chip.items() if k not in ("id", "file", "mtime")}
    f = CATALOG / "chips" / f"{chip['id']}.json"
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, f)


def update_chip(cid, body):
    with LOCK:
        chip = load_chip(cid)
        for k, default in FIELDS.items():
            if k in body:
                if not isinstance(body[k], type(default)):
                    raise ValueError(f"{k} has the wrong type")
                chip[k] = body[k]
        if not all(isinstance(a, str) for a in chip["authors"]):
            raise ValueError("authors must be a list of strings")
        if chip["run"] and not re.fullmatch(r"\d{4}-\d{2}", chip["run"]):
            raise ValueError("run must be YYYY-MM")
        if chip["github"] and not re.match(r"https?://", chip["github"]):
            raise ValueError("github must be an http(s) URL")
        if "wafers" in body:
            maps, old = wafer_maps(), {w["id"]: w for w in chip["wafers"]}
            wafers = []
            for w in body["wafers"]:
                if w.get("map") not in maps:
                    raise ValueError(f"unknown wafer map {w.get('map')!r}")
                prev = old.get(w.get("id"), {})  # match by id so remove and rename keep die records
                wafers.append({"id": prev.get("id") or uuid.uuid4().hex[:8], "name": str(w.get("name") or "Wafer"),
                               "map": w["map"], "dies": prev.get("dies", {})})
            chip["wafers"] = wafers
        save_chip(chip)
        return chip


def update_die(cid, wid, label, body):
    with LOCK:
        chip = load_chip(cid)
        wafer = next((w for w in chip["wafers"] if w["id"] == wid), None)
        if wafer is None or label not in map_labels(wafer_maps()[wafer["map"]]):
            raise KeyError(label)
        statuses = list(config()["statuses"])
        die = wafer["dies"].setdefault(label, {"status": statuses[0], "notes": ""})
        if "status" in body:
            if body["status"] not in statuses:
                raise ValueError(f"status must be one of {statuses}")
            die["status"] = body["status"]
        if "notes" in body:
            die["notes"] = str(body["notes"])
        save_chip(chip)
        return die


def add_layout(name, stream, size):
    """Save an uploaded layout file into gds/. The file name gives the chip id."""
    name = Path(name).name
    stem, ext = os.path.splitext(name)
    if ext.lower() not in LAYOUT_EXTS:
        raise ValueError(f"the file must be one of {sorted(LAYOUT_EXTS)}")
    if not re.fullmatch(r"[\w\-. ()]+", stem) or stem.startswith("."):
        raise ValueError("use only letters, digits, spaces and - _ . ( ) in the file name")
    if size > MAX_UPLOAD:
        raise ValueError("the file is too large")
    tmp = CATALOG / "gds" / f".upload-{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "wb") as f:
            while size > 0:
                chunk = stream.read(min(size, 1 << 20))
                if not chunk:
                    raise ValueError("the upload stopped before the end of the file")
                f.write(chunk)
                size -= len(chunk)
        with LOCK:
            try:
                db.Layout().read(str(tmp))
            except RuntimeError as e:
                raise ValueError(f"KLayout cannot read this file: {e}")
            if stem.lower() in (k.lower() for k in layouts()):
                raise ValueError(f"a chip with the id {stem!r} already exists")
            os.replace(tmp, CATALOG / "gds" / name)
    finally:
        tmp.unlink(missing_ok=True)
    return load_chip(stem)


# ---------- layouts (call with LOCK held) ----------

@lru_cache(maxsize=6)
def _view(path, mtime, lyp):
    lv = lay.LayoutView()
    lv.set_config("grid-visible", "false")
    lv.load_layout(path, True)
    ly = lv.active_cellview().layout()
    top = max(ly.top_cells(), key=lambda c: c.bbox().area())
    lv.select_cell(top.cell_index(), 0)
    lv.max_hier()
    if lyp:
        lv.load_layer_props(lyp, 0, True)  # True: layers missing from the .lyp still show in default colours
    return lv, ly, top


def view(cid):
    path, chip = layouts()[cid], load_chip(cid)
    return _view(str(path), path.stat().st_mtime, lyp_for(chip["technology"]))


def layer_nodes(lv):
    """Yield (id, node, group name) for each layer in the layer list. Groups are not yielded."""
    it, group = lv.begin_layers(), None
    n = 0
    while not it.at_end():
        node = it.current()
        if node.has_children():
            group = node.name
        else:
            yield n, node, None if it.at_top() else group
        n += 1
        it.next()


def layer_list(lv):
    """Layers that have shapes in the layout, with the visibility from the .lyp file."""
    return [{"id": n, "name": node.name or node.source.split("@")[0], "group": group,
             "colour": f"#{node.eff_fill_color(True) & 0xffffff:06x}", "visible": node.visible}
            for n, node, group in layer_nodes(lv) if node.layer_index() >= 0]


def render(lv, box, w, h, bg, hidden=None):
    """Render a box. hidden is a set of layer ids to hide, or None for the .lyp visibility."""
    lv.set_config("background-color", BACKGROUNDS[bg])
    if hidden is None:
        return lv.get_pixels_with_options(w, h, 0, 0, 0, box).to_png_data()
    defaults = {n: node.visible for n, node, _ in layer_nodes(lv)}
    try:
        for n, node, _ in layer_nodes(lv):
            node.visible = n not in hidden
        return lv.get_pixels_with_options(w, h, 0, 0, 0, box).to_png_data()
    finally:  # other users share this view
        for n, node, _ in layer_nodes(lv):
            node.visible = defaults[n]


def background(q):
    bg = q.get("bg", "dark")
    if bg not in BACKGROUNDS:
        raise ValueError(f"bg must be one of {list(BACKGROUNDS)}")
    return bg


def box_list(b):
    return [b.left, b.bottom, b.right, b.top]


def thumbnail(cid, bg):
    chip = load_chip(cid)
    tag = re.sub(r"\W", "_", chip["technology"]) or "default"
    out = CATALOG / "chips" / ".thumbs" / f"{cid}.{tag}.{bg}.png"
    if not out.exists() or out.stat().st_mtime < chip["mtime"]:
        lv, ly, top = view(cid)
        b = top.dbbox()
        out.parent.mkdir(exist_ok=True)
        out.write_bytes(render(lv, b.enlarged(b.width() * 0.01, b.height() * 0.01), 640,
                               max(64, min(640, round(640 * b.height() / max(b.width(), 1e-9)))), bg))
    return out.read_bytes()


def children(ly, cell):
    counts = {}
    for inst in cell.each_inst():
        counts[inst.cell_index] = counts.get(inst.cell_index, 0) + inst.size()
    return [{"name": ly.cell(ci).name, "count": n, "leaf": ly.cell(ci).child_cells() == 0}
            for ci, n in sorted(counts.items(), key=lambda kv: ly.cell(kv[0]).name.lower())]


def search_cells(ly, top, q):
    names = [ly.cell(ci).name for ci in top.called_cells()]
    return sorted((n for n in names if q.lower() in n.lower()), key=str.lower)[:300]


def instance_boxes(ly, top, name):
    """Bounding boxes in top-cell microns of every placement of a cell, at any depth."""
    cell = ly.cell(name)
    if cell is None:
        raise KeyError(name)
    if cell.cell_index() == top.cell_index():
        return [box_list(top.dbbox())], False
    it = db.RecursiveInstanceIterator(ly, top)
    it.targets = [cell.cell_index()]
    boxes = []
    while not it.at_end() and len(boxes) < MAX_BOXES:
        boxes.append(box_list(cell.dbbox().transformed(it.dtrans() * it.inst_dtrans())))
        it.next()
    return boxes, not it.at_end()


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def send(self, body, ctype="application/json", code=200, cache=False):
        if ctype == "application/json":
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def dispatch(self, fn):
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.strip("/").split("/")]
        if parts[0] != "api":
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            fn(parts[1:], q)
        except KeyError as e:
            self.close_connection = True  # the request body can be unread
            self.send({"error": f"not found: {e}"}, code=404)
        except (ValueError, TypeError) as e:
            self.close_connection = True
            self.send({"error": str(e)}, code=400)

    def do_GET(self):
        self.dispatch(self.get)

    def do_PUT(self):
        self.dispatch(self.put)

    def do_POST(self):
        self.dispatch(self.post)

    def get(self, parts, q):
        match parts:
            case ["config"]:
                self.send({**config(), "techs": list(techs()), "wafermaps": wafer_maps()})
            case ["chips"]:
                self.send([load_chip(cid) for cid in layouts()])
            case ["chips", cid]:
                with LOCK:
                    chip = load_chip(cid)
                    lv, ly, top = view(cid)
                    self.send({**chip, "top": top.name, "bbox": box_list(top.dbbox()),
                               "lyp": Path(lyp_for(chip["technology"]) or "").name or None})
            case ["chips", cid, "thumb.png"]:
                with LOCK:
                    self.send(thumbnail(cid, background(q)), "image/png", cache=True)
            case ["chips", cid, "render.png"]:
                l, b, r, t = map(float, q["box"].split(","))
                w, h = (max(1, min(4096, int(q[k]))) for k in ("w", "h"))
                if not (r > l and t > b):
                    raise ValueError("empty box")
                with LOCK:
                    lv, ly, top = view(cid)
                    hidden = {int(n) for n in q["hide"].split(",") if n} if "hide" in q else None
                    self.send(render(lv, db.DBox(l, b, r, t), w, h, background(q), hidden), "image/png", cache=True)
            case ["chips", cid, "layers"]:
                with LOCK:
                    self.send(layer_list(view(cid)[0]))
            case ["chips", cid, "cells"]:
                with LOCK:
                    lv, ly, top = view(cid)
                    if "q" in q:
                        self.send(search_cells(ly, top, q["q"]))
                    else:
                        parent = ly.cell(q.get("parent", top.name))
                        if parent is None:
                            raise KeyError(q["parent"])
                        self.send(children(ly, parent))
            case ["chips", cid, "boxes"]:
                with LOCK:
                    lv, ly, top = view(cid)
                    boxes, truncated = instance_boxes(ly, top, q["cell"])
                    self.send({"boxes": boxes, "truncated": truncated})
            case _:
                raise KeyError(self.path)

    def post(self, parts, q):
        match parts:
            case ["chips"]:
                self.send(add_layout(q["file"], self.rfile, int(self.headers.get("Content-Length", 0))), code=201)
            case _:
                raise KeyError(self.path)

    def put(self, parts, q):
        n = int(self.headers.get("Content-Length", 0))
        if n > MAX_BODY:
            raise ValueError("request too large")
        body = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(body, dict):
            raise ValueError("body must be a JSON object")
        match parts:
            case ["chips", cid]:
                self.send(update_chip(cid, body))
            case ["chips", cid, "wafers", wid, "dies", label]:
                self.send(update_die(cid, wid, label, body))
            case _:
                raise KeyError(self.path)


def main():
    global CATALOG
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", default=os.environ.get("CHIP_CATALOG", "catalog"), help="catalog directory")
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to share on the network")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    CATALOG = Path(a.catalog).resolve()
    for d in ("gds", "tech", "wafermaps", "chips"):
        (CATALOG / d).mkdir(parents=True, exist_ok=True)
    print(f"Catalog {CATALOG}: {len(layouts())} layouts. Open http://{a.host}:{a.port}/")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
