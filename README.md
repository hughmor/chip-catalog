# Chip Catalog

Chip Catalog is a web catalog of chip layouts. The main page shows a preview of each chip. Click a chip to open a full-screen GDS/OASIS viewer with an information panel. The panel shows the chip record, a cell tree, and wafer maps that record the status of each die.

The app holds no lab data. All data lives in one catalog directory. Another lab can use the app with its own catalog directory.

## Set up for your organisation

This repository holds only the app. Git ignores the `catalog/` directory, so your layouts and chip records never go into this repository.

1. Fork or clone this repository.
2. Make a Python environment: `python3 -m venv .venv`
3. Install KLayout: `.venv/bin/pip install -r requirements.txt`
4. Copy the example catalog: `cp -r catalog.example catalog`
5. Set your title in `catalog/config.json`.
6. Copy your layout files into `catalog/gds/`.
7. Copy your KLayout layer properties into `catalog/tech/`, one `<technology>.lyp` for each technology.
8. Write a wafer map for each wafer layout in `catalog/wafermaps/`. Use `example.json` as a model.
9. Start the server: `.venv/bin/python server.py`
10. Open http://127.0.0.1:8000/ in a browser.

The server uses `./catalog` by default. To use a different directory, give `--catalog DIR` or set the `CHIP_CATALOG` environment variable.

To share the catalog on your network, add `--host 0.0.0.0`. The server has no login. Anyone who can reach the port can edit records. Use it only on a trusted network.

### Keep your catalog in version control

Your catalog is data, not app code. To keep a history of chip records, make the catalog a separate private repository:

1. Go to the catalog directory: `cd catalog`
2. Make a repository: `git init`
3. Commit the records and push them to a private remote of your organisation.

Layout files are large. Use Git LFS for `gds/`, or keep `gds/` out of the catalog repository.

### Get app updates

If you forked this repository, add it as a remote, then merge from it:

1. Add the remote: `git remote add upstream <URL of this repository>`
2. Merge the updates: `git pull upstream main`

The catalog directory is not part of the app repository, so updates do not change your data.

### Check the server

Run `.venv/bin/python test_server.py`. The test makes its own small layout and does not use the catalog.

## Use the viewer

- Scroll to zoom. Drag to pan. Click **Fit** to see the full chip.
- In the **Layers** tab, clear a check box to hide a layer. Click a group name to show or hide all the layers in the group. The list shows only the layers that the layout uses.
- Click **◐** to change between light and dark mode. The layout background also changes.
- In the **Cells** tab, expand the cell tree, or search all cells by name. Click a cell name to highlight each placement of that cell and zoom to it. Clear the check box next to a cell to hide it. The viewer then shows only its outline and name. Click **Show all cells** to show all cells again.
- The chip page opens in read-only mode. Click **Edit** to change the chip record or the die status. Click **Done** to go back to read-only mode.
- In edit mode, change the chip record in the **Info** tab and click **Save**. Click **+** to add an author line.
- In the **Wafers** tab, select a wafer. In edit mode, select a status in the legend, then click dies to set that status. With **cycle**, each click moves a die to the next status. Hover over a die to see its notes. Click **Table** to edit the status and notes of each die in a list. Dies with notes have a white border.

## Catalog directory

```
catalog/
  config.json     optional settings
  gds/            layout files: .gds, .gds2, .gdsii, .oas
  tech/           KLayout layer properties: <technology>.lyp
  wafermaps/      wafer map templates: <map id>.json
  chips/          chip records: <chip id>.json
```

You can keep the catalog directory in its own git repository. The JSON files are small, and git shows each change clearly. Layout files are large, so think about Git LFS for `gds/`.

### Layout files

One layout file is one chip. The chip ID is the file name without the extension. Two chips cannot have the same ID, even with different letter case.

To add a chip, do one of these steps:

- On the catalog page, click **+ Add chip**. Select the layout file, fill in the record, and click **Add chip**.
- Copy the layout file into `gds/` and reload the catalog page. The server makes the chip record when a user first saves it.

To remove a chip, stop the server. Then delete its layout file from `gds/` and its record from `chips/`.

The viewer shows the top cell with the largest area. A file can have more than one top cell, but the viewer shows only that one.

### Layer properties

Each chip has a technology name. If `tech/` has a `.lyp` file with the same name, the viewer uses it. The match ignores letter case, so the technology `mytech` uses `tech/MyTech.lyp`. If no file matches, or the technology is empty, KLayout gives each layer a default colour. Layers that are not in the `.lyp` file also get a default colour.

To get a `.lyp` file, set up the layers in KLayout, then use **File > Save Layer Properties**.

### Chip records

The server writes `chips/<chip id>.json`. You can also edit these files by hand when the server is stopped.

```json
{
  "internal_name": "Neuron test chip A",
  "designation": "MPW21-017",
  "technology": "MyTech",
  "github": "https://github.com/your-lab/neuron-chip",
  "authors": ["A. Person", "B. Person"],
  "notes": "Free text.",
  "run": "2021-05",
  "wafers": [
    {"id": "a5609b5a", "name": "undercut", "map": "mpw200",
     "dies": {"12": {"status": "tested", "notes": "Ring 3 is cracked."}}},
    {"id": "38b5f247", "name": "non-undercut", "map": "mpw200", "dies": {}}
  ]
}
```

- `run` is the run month in the form `YYYY-MM`.
- `github` must start with `http://` or `https://`.
- `wafers` is empty for a one-off die. A chip run with two wafers (for example undercut and non-undercut) has two entries. Each wafer has its own die records.
- `map` is the ID of a file in `wafermaps/`.
- `id` identifies the wafer. The server makes it. Do not change it.
- `dies` holds records only for dies that a user changed. A die with no record has the first status in the status list.

### Wafer maps

A wafer map is a JSON file in `wafermaps/`. The file name without `.json` is the map ID. Many chips can use the same map.

```json
{
  "name": "200 mm MPW",
  "die_size": [25, 30],
  "wafer_diameter": 200,
  "col_labels": ["-1", "0", "1"],
  "row_labels": ["2", "1", "-1"],
  "rows": [
    "_  1  _",
    "2  3  4",
    ".  5  ."
  ]
}
```

- `rows` is the die grid, from the top of the wafer to the bottom. Each string is one row of labels, separated by spaces. A `.` is a position with no die. A `_` is an empty site: the map draws its outline, but it is not a die. Labels can be any text without spaces, for example `A3` or `12`. Each label must be unique in the map.
- `die_size` is the width and height of one die. It sets the shape of each die in the drawing. The default is `[1, 1]`.
- `wafer_diameter` is optional. It is in the same unit as `die_size`. The viewer draws a wafer outline with this diameter, centred on the die grid.
- `col_labels` and `row_labels` are optional. They give one axis label for each column and each row. The map shows them on all four sides.
- `name` is the name in the menus.

Die records use the labels as keys. If you change the labels in a map, records for old labels stay in the chip file but do not show.

### Settings

`config.json` is optional. These are the default values:

```json
{
  "title": "Chip Catalog",
  "statuses": {
    "unknown": "#9e9e9e",
    "untested": "#4a90d9",
    "tested": "#3cb371",
    "damaged": "#d9534f",
    "offsite": "#c58af9"
  }
}
```

`statuses` gives each die status a colour. The first status is the status of a die with no record. If you remove a status that a die uses, that die shows in grey.

## How it works

`server.py` uses the KLayout Python package to read layouts and render images. The browser asks for an image of the visible region at each pan or zoom. KLayout keeps the cell hierarchy, so large layouts render in about one second. The server keeps the six most recent layouts in memory. Thumbnails are cached in `chips/.thumbs/`.

The front end is plain HTML and JavaScript in `static/`. It needs no build step.
