"""Self-check: .venv/bin/python test_server.py"""
import json
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from klayout import db

import server


def call(base, path, body=None):
    req = urllib.request.Request(base + path, method="PUT" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req) as r:
            data = r.read()
            return r.status, json.loads(data) if r.headers["Content-Type"] == "application/json" else data
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def make_catalog(root):
    for d in ("gds", "tech", "wafermaps", "chips"):
        (root / d).mkdir()
    ly = db.Layout()
    top, a, b = ly.create_cell("TOP"), ly.create_cell("A"), ly.create_cell("B")
    b.shapes(ly.layer(1, 0)).insert(db.Box(0, 0, 1000, 1000))  # 1 x 1 um at dbu 0.001
    a.insert(db.CellInstArray(b.cell_index(), db.Trans(db.Point(5000, 0))))
    top.insert(db.CellInstArray(a.cell_index(), db.Trans(db.Point(0, 0))))
    top.insert(db.CellInstArray(a.cell_index(), db.Trans(db.Point(0, 20000))))
    ly.write(str(root / "gds" / "demo chip.gds"))
    (root / "wafermaps" / "small.json").write_text(json.dumps({"name": "Small", "rows": [". 1 .", "2 3 4"]}))


def main():
    with tempfile.TemporaryDirectory() as tmp:
        server.CATALOG = Path(tmp)
        make_catalog(server.CATALOG)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base, c = f"http://127.0.0.1:{httpd.server_port}", "/api/chips/demo%20chip"

        code, chips = call(base, "/api/chips")
        assert code == 200 and chips[0]["id"] == "demo chip" and chips[0]["internal_name"] == "demo chip"

        code, chip = call(base, c)
        assert chip["top"] == "TOP" and chip["bbox"] == [5, 0, 6, 21] and chip["lyp"] is None, chip

        assert call(base, "/api/chips/nope")[0] == 404
        assert call(base, f"{c}/cells")[1] == [{"name": "A", "count": 2, "leaf": False}]
        assert call(base, f"{c}/cells?q=b")[1] == ["B"]
        code, boxes = call(base, f"{c}/boxes?cell=B")
        assert sorted(boxes["boxes"]) == [[5, 0, 6, 1], [5, 20, 6, 21]] and not boxes["truncated"], boxes

        code, png = call(base, f"{c}/render.png?box=0,0,10,10&w=50&h=50")
        assert code == 200 and png[:4] == b"\x89PNG"
        assert call(base, f"{c}/thumb.png")[1][:4] == b"\x89PNG"
        assert call(base, f"{c}/render.png?box=1,1,0,0&w=5&h=5")[0] == 400

        # metadata validation
        assert call(base, c, {"github": "javascript:alert(1)"})[0] == 400
        assert call(base, c, {"run": "May 2021"})[0] == 400
        assert call(base, c, {"authors": "Ann"})[0] == 400
        assert call(base, c, {"wafers": [{"name": "X", "map": "missing"}]})[0] == 400
        code, chip = call(base, c, {"run": "2021-05", "authors": ["Ann", "Bo"],
                                    "wafers": [{"name": "undercut", "map": "small"}, {"name": "plain", "map": "small"}]})
        assert code == 200 and chip["run"] == "2021-05" and len(chip["wafers"]) == 2
        w0, w1 = (w["id"] for w in chip["wafers"])

        # die records, by wafer id
        assert call(base, f"{c}/wafers/{w1}/dies/3", {"status": "tested", "notes": "ring OK"})[1] == {"status": "tested", "notes": "ring OK"}
        assert call(base, f"{c}/wafers/{w1}/dies/3", {"status": "broken"})[0] == 400
        assert call(base, f"{c}/wafers/{w1}/dies/99", {"status": "tested"})[0] == 404
        assert call(base, f"{c}/wafers/zzz/dies/3", {"status": "tested"})[0] == 404

        # removing the first wafer must keep the second wafer's die records
        code, chip = call(base, c, {"wafers": [{"id": w1, "name": "plain", "map": "small"}]})
        assert chip["wafers"] == [{"id": w1, "name": "plain", "map": "small", "dies": {"3": {"status": "tested", "notes": "ring OK"}}}], chip
        assert json.loads((server.CATALOG / "chips" / "demo chip.json").read_text())["authors"] == ["Ann", "Bo"]

        # upload a layout
        def upload(name, data):
            req = urllib.request.Request(f"{base}/api/chips?file={urllib.parse.quote(name)}", data=data, method="POST")
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        gds = (server.CATALOG / "gds" / "demo chip.gds").read_bytes()
        code, new = upload("../new_chip.GDS", gds)
        assert code == 201 and new["id"] == "new_chip" and (server.CATALOG / "gds" / "new_chip.GDS").exists(), new
        assert upload("Demo Chip.oas", gds)[0] == 400  # same id, other case
        assert upload("junk.gds", b"not a layout")[0] == 400
        assert upload("notes.txt", gds)[0] == 400
        assert sorted(p.name for p in (server.CATALOG / "gds").iterdir()) == ["demo chip.gds", "new_chip.GDS"]
        assert len(call(base, "/api/chips")[1]) == 2

        # a technology with a .lyp file selects it, case-insensitive
        (server.CATALOG / "tech" / "MyTech.lyp").write_text("<layer-properties/>")
        call(base, c, {"technology": "mytech"})
        assert call(base, c)[1]["lyp"] == "MyTech.lyp"
        httpd.shutdown()
    print("ok")


if __name__ == "__main__":
    main()
