# CosmosEx floppy image lists

A CosmosEx can search and insert floppy images from several sources: web lists,
a network share and USB sticks. Each source can have a list file that says which
images it has. There are two formats:

- **Legacy CSV** (`imagelist.csv`): the original format. It keeps working
  unchanged.
- **Extended JSON** (`imagelist.json`): adds proper titles, multi-disk games,
  MD5s and pictures.

The CosmosEx detects the format by content, not by file name: if the first
non-blank character is `{`, it is JSON, otherwise CSV. In a local folder,
`imagelist.json` wins over `imagelist.csv`. A folder with neither is scanned
for images.

The machine-readable schema is [`imagelist.schema.json`](imagelist.schema.json)
(JSON Schema 2020-12).

## Legacy CSV

```
2025-06-01
http://example.org/floppies/A/Automation_100.zip,0x1a2b,Xenon 2,Ikari Warriors
http://example.org/floppies/B/Oids.st,0x0f3c,Oids
```

Line 1 is the list version. Every other line is `url,checksum,game,game,...`.
Each line is one entry with one disk.

## Extended JSON (format_version 1)

```json
{
  "format": "cosmosex-imagelist",
  "format_version": 1,
  "list_version": "2026-10-15",
  "name": "NAS library",
  "entries": [
    {
      "id": "automation-100",
      "title": "Automation Disk 100",
      "type": "compilation",
      "games": [
        { "title": "Xenon 2: Megablast" },
        { "title": "Ikari Warriors",
          "media": [ { "role": "screenshot", "src": "thumbs/auto100-ikari.png" } ] }
      ],
      "disks": [
        { "file": "menus/auto_100.zip", "size": 412833,
          "md5": "9e107d9d372bb6826bd81d3542a419d6",
          "container": "zip", "format": "msa",
          "inner_md5": "e4d909c290d0fb1ca068ffaddf22cbd0" }
      ],
      "media": [ { "role": "title", "src": "thumbs/auto_100_title.png" } ]
    },
    {
      "id": "dungeon-master",
      "title": "Dungeon Master",
      "type": "game",
      "year": 1987,
      "disks": [
        { "file": "originals/dm/dm_disk1.st", "label": "Game disk" },
        { "file": "originals/dm/dm_disk2.st", "label": "Utility / save disk" }
      ],
      "media": [ { "role": "thumbnail", "mime": "image/png",
                   "data": "iVBORw0KGgoAAAANSUhEUgAA..." } ]
    }
  ]
}
```

A complete, valid example is in
[`tests/fixtures/imagelist-example.json`](../tests/fixtures/imagelist-example.json).

### Top level

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `"cosmosex-imagelist"`. |
| `format_version` | yes | `1`. A CosmosEx refuses lists with a higher version. |
| `entries` | yes | The list of entries (see below). |
| `list_version` | no | Version shown in the update check, e.g. a date. Replaces the CSV first line. |
| `name`, `description` | no | Shown to the user. |
| `base_url` | no | Web lists: the folder that relative `file` / `src` paths are relative to. Default: the folder of the list's URL. |
| `generated` | no | When the list was made (ISO 8601). |

### Entry

An entry is one release: a game, or a compilation / menu disk.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the list. Letters, digits, `.`, `_`, `-`; at most 64 characters. Keep it stable when you rebuild the list. |
| `title` | yes | Shown and searched. At most 256 characters. |
| `disks` | yes | One or more disks (at most 32), in insert order: disk 1 goes into drive A. |
| `games` | no | Games on the disk(s). Plain strings or `{ "title": ..., "media": [...] }` objects. Default: the entry title. Search looks at these too. |
| `media` | no | Pictures (see below). |
| `type` | no | e.g. `game`, `compilation`, `demo`. |
| `group`, `year`, `tags`, `compat`, `links` | no | Extra information for the web UI. |

Entries with a missing, invalid or duplicate `id` are skipped by the CosmosEx.

### Disk

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | The image file (`.st`, `.msa`, or a `.zip` with one of those inside). See the path rules. |
| `label` | no | e.g. `"Disk 2"` or `"Save disk"`. |
| `size`, `md5` | no | Size and MD5 of the file as stored. |
| `container`, `format` | no | `zip` for zipped images; `st` or `msa` for the image itself. |
| `inner_md5` | no | MD5 of the image inside a zip. Best key for finding duplicates. |
| `checksum` | no | The legacy CSV checksum, if you have one. |

### Path rules

`file` and `src` are relative to where the list is:

- local lists (share, USB): the folder the list is in;
- web lists: `base_url`, or else the folder of the list's URL.

Not allowed: `..` path components, absolute paths (`/x`, `C:\x`), `file://`,
and any URL scheme other than `http` / `https`. Full `http(s)` URLs are allowed
only in web lists. Bad references are skipped.

### Unknown fields

Unknown fields are ignored, so you can add your own.

## Pictures

`media` is a list of pictures. Each item has a `role`: `thumbnail`, `title`,
`screenshot`, `box` or `other`. Menu disks can also have pictures per game
(in each game's `media`).

In the web interface's library, a result shows the entry's first `thumbnail`
(or else the first `title`, then the first `screenshot`). When the entry has
more `thumbnail`, `title` or `screenshot` pictures, for example one per game
on a menu disk, the picture cross-fades through them (up to 8; not when the
browser asks for reduced motion). `box` and `other` pictures aren't shown yet.

Each item has **exactly one** of:

- `data`: the picture as base64 (standard alphabet). A
  `data:image/png;base64,` prefix is accepted.
- `src`: a picture file, relative like `file`, or an `http(s)` URL in web lists.

`mime`, `width`, `height` and `caption` are optional hints.

Rules:

- Only PNG, JPEG, WebP and GIF. The real type is taken from the file's first
  bytes, not from `mime` or the file name. **No SVG.**
- At most 256 KB per picture and 16 pictures per entry (entry and game pictures
  together). Bigger or extra pictures are skipped.

Which to use:

- **Small, self-contained lists:** inline `data` thumbnails. One file has
  everything.
- **Big lists:** `src` references. Inline pictures make the list file large
  (3,000 entries with 15 KB thumbnails is about 45 MB), and with `src` the
  browser loads only the pictures it shows.
