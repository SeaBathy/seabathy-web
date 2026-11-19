# SeaBathy web app

**See what's under the boat, on an iPhone.** Download free seabed depths for anywhere in the
world, fly over them in 3D, and take them out with no signal. It runs in the browser and
installs from Safari to the Home Screen, so it needs no App Store. It also works on Android
and on a computer.

> **Not for navigation.** SeaBathy is not a nautical chart and must not be used for navigation.
> Its data comes from public sources and from the files you load, and can be wrong or out of
> date. Use official charts and proper navigation equipment. See the
> [terms of use](https://seabathy.com/terms).

This is the web version of [SeaBathy](https://seabathy.com). It has the core of the Android
app: depth download, the 3D seabed, depth colours, satellite, waypoints and GPS. The Android
and Windows apps do more (high-detail Australian depths, tides, sea conditions, routes, tracks,
anchor alarm).

## Contents

- [Install on an iPhone or iPad](#install-on-an-iphone-or-ipad)
- [Get depths](#get-depths)
- [The seabed in 3D](#the-seabed-in-3d)
- [What it does](#what-it-does)
- [What an iPhone web app can't do](#what-an-iphone-web-app-cant-do)
- [Storage on the phone](#storage-on-the-phone)
- [Your own files](#your-own-files)
- [Publishing the app](#publishing-the-app)
- [Development and tests](#development-and-tests)
- [Privacy](#privacy)
- [Credits and licence](#credits-and-licence)

## Install on an iPhone or iPad

1. Open the app's web address in **Safari**.
2. Tap the **Share** button (a square with an arrow pointing up). On newer iPhones it is under
   the **•••** button.
3. Scroll down and tap **Add to Home Screen**.
4. Leave **Open as Web App** on, then tap **Add**.
5. Open SeaBathy from its new icon while you still have internet. It saves itself on the phone
   the first time, and after that it opens with no signal.

Install first, then get your depths. Safari and the installed app keep their data apart, so
anything you add in Safari does not appear in the installed app.

Needs iOS 15.2 or newer. On Android, open the address in Chrome and choose **Install app**.

## Get depths

1. Move the chart to the water you want and zoom until it fills the screen.
2. Menu (☰) → **Get seabed depths** → **Download**.
3. The depths arrive as a coloured layer and are kept on the phone. From then on they work
   with no signal.

The depths come from GMRT, a free worldwide model built from ship surveys. They are sharpest
where ships have surveyed and coarser elsewhere. One download holds up to about 440 km across
and 55 MB; a smaller area comes in finer detail, so zoom in for the spot that matters.

## The seabed in 3D

Tap **3D** on the chart while depths are on screen (or **See it in 3D** on a depth layer).
The viewer is the Android app's own:

- One finger rotates, two fingers pan and zoom, double-tap flies in. Tap for the depth and slope.
- **View:** height from true scale (1:1) to 100×, camera presets, a depth profile between two
  taps, the boat from GPS.
- **Depth:** show just a depth band, such as 10 to 30 m, and **Isolate & zoom** to reload that
  band at full detail. Depths are typed as on a chart: `-30` to `-10`.
- **Colours:** palettes and your own colour range, or colour by slope to find ledges and
  drop-offs.
- **Map:** the satellite picture laid on the seabed, with a blend slider, and **Save this area
  offline**.
- **Contours** with depth labels, and **Light** for the sun, shadows and the sea surface.

Where the area takes in land, 3D opens on the water alone; the Depth tab brings the land back.

## What it does

- **Free depths anywhere,** downloaded in the app and kept on the phone.
- **3D seabed** of any depth layer, with everything listed above.
- **Depth colours** on the chart: seven palettes, your own depth range, ready-made ranges
  (reef, inshore, coastal, offshore) and relief shading. The depth at the crosshair.
- **Basemaps:** dark, street map, OpenStreetMap, OpenTopoMap, USGS imagery, your own tile link
  with its credit, or none.
- **Satellite picture** over the chart with an opacity slider, and savable for offline use.
- **Waypoints:** add at the crosshair, by holding a finger on the chart, or by tapping the
  seabed in 3D; name, note, colour and symbol; saved on the phone.
- **GPX in and out,** to back up waypoints and to move them between SeaBathy, a plotter and
  other apps.
- **GPS:** the boat on the chart and in 3D, with speed, course and accuracy, and a follow mode.
- **Your own files:** GeoTIFF depth surveys and PMTiles charts.
- **Storage:** how much the app is using, and a delete button for every layer and saved area.

## What an iPhone web app can't do

- **No GPS with the screen locked.** The position stops when the phone locks or another app is
  in front, so there is no track recording in a pocket and no overnight anchor alarm.
- **No high-detail Australian depths yet.** The Android app builds these from the IMAS
  composite, but that server does not let web pages read it, as browsers require. It would
  need IMAS to allow it, or a small relay in between.
- **The phone may ask for location permission again** on later launches.
- **Smaller limits than the Android app.** The 3D view holds about a million cells, which a
  phone browser draws comfortably.
- **Installing is by hand,** from Safari. There is no App Store listing.

## Storage on the phone

Everything is kept inside the app on the phone: depth layers and charts in its private file
storage, waypoints, settings and saved map tiles in its database. An iPhone lets an installed
web app use up to about 60% of the phone's storage.

- The app asks the phone to keep its data. iOS decides, and is more likely to agree for an app
  on the Home Screen. **Storage** in the menu shows the answer.
- Without that promise, iOS may clear the data if the phone runs very short of space.
- Removing the app from the Home Screen deletes its data.

Downloaded depths can always be downloaded again. Export your waypoints as GPX now and then.

## Your own files

Copy the file to the phone's **Files** app, then menu → **Charts** → **Load a file from this
phone**. It is copied into the app, so it needs free space of about twice its size while it
loads.

| File | What it is |
|---|---|
| `.tif` | A GeoTIFF depth survey, in longitude and latitude or in a projection such as UTM or MGA. Works in 3D |
| `.pmtiles` | A chart pack: depth shapes, contour lines or chart pictures |

Depth shapes and contours are coloured by a number on each shape. The app looks for a field
called `depth`, `contour`, `elevation` or similar, and works out whether depths are written as
positive numbers. If it picks the wrong one, choose the field under the chart's settings.

An MBTiles file must be converted first, on a computer, with the free
[`pmtiles` tool](https://github.com/protomaps/go-pmtiles/releases):

```bash
pmtiles convert chart.mbtiles chart.pmtiles
```

A PMTiles chart can also be read straight from a web address. The server must use HTTPS,
answer part-file (range) requests and allow other sites to read it (CORS).

## Publishing the app

The app is plain files with no build step, so any static host works. On GitHub Pages:

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder
   `/ (root)`.
3. Wait a minute, then open the address Pages gives you.

**Choose the final address before anyone uses it.** A phone ties saved depths and waypoints to
the app's web address. If the address changes later (a new domain, a renamed repository),
everyone starts again with an empty app.

**When you change any file,** raise `VERSION` in `sw.js`, `js/install.js` and `package.json`.
That is what makes phones fetch the new copy; they offer it with a "new version is ready" bar.

## Development and tests

```bash
npm install
npx playwright install webkit chromium
npm test
```

`npm test` serves the app over HTTPS on this computer and drives it in WebKit (Safari's
engine) set up as an iPhone: first start, offline reload, a seabed download, the 3D view,
GeoTIFF surveys, a PMTiles chart, waypoints, GPX, GPS, a web chart, saving an area, a restart
and deleting a layer. `ENGINE=chromium npm test` runs the same steps in Chromium. `npm run
serve` just serves the app at `https://localhost:8443/`. The test files are made by the tests
themselves, and their own server stands in for the depth service.

**WebKit on Windows is a cut-down build.** It can't write to private file storage, and with a
profile kept on disk it is very slow and its service worker never finishes installing. So on
Windows the WebKit tests use a private window and leave out three checks: a file copied into
the app's storage, a restart, and deleting a layer. Chromium runs those on Windows. WebKit on
Linux and on a Mac runs every check, and the Playwright container does that from any computer:

```bash
docker run --rm --ipc=host -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.65.1-noble npm test
```

Every push to GitHub also runs the tests in WebKit on a Mac (`.github/workflows/test.yml`).

WebKit on a computer is still not an iPhone. The file picker, the Home Screen install, storage
limits and real GPS can only be checked on a phone.

| Folder | What's in it |
|---|---|
| `js/` | The app: `app.js` starts it; `seabed.js` downloads depths; `survey.js`, `charts.js` and `depth.js` read and draw them; `terrain.js` runs the 3D view; `basemap.js`, `waypoints.js`, `gps.js`, `offline.js`, `files.js`, `db.js` are what their names say |
| `3d/` | The 3D viewer: the Android app's (`terrain3d-web`), unchanged but for where it loads three.js from and how it is handed its grid and map tiles |
| `vendor/` | MapLibre GL JS, three.js, PMTiles, geotiff.js and proj4js, as released, with their licences. The two three.js add-ons have their import line pointed at the copy beside them |
| `glyphs/` | Lettering for depth labels, kept with the app so labels work offline |
| `sw.js` | Keeps the app's own files on the phone for offline use |
| `tests/` | The tests and their small HTTPS server |

## Privacy

SeaBathy has no accounts, ads or analytics, and sends nothing to this project. Your position,
waypoints and depths stay on your phone. When you download depths, use an online map, or read
a chart at a web address, your phone asks that service directly, so it sees your internet
address and the area you asked for. One more request can happen: a survey in an unusual map
projection makes the app ask [epsg.io](https://epsg.io) once for that projection's definition,
by its number.

## Credits and licence

- **Code:** GNU GPL-3.0, see [LICENSE](LICENSE).
- **Libraries:** [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) and
  [PMTiles](https://github.com/protomaps/PMTiles) (BSD 3-Clause),
  [three.js](https://github.com/mrdoob/three.js),
  [geotiff.js](https://github.com/geotiffjs/geotiff.js) and
  [proj4js](https://github.com/proj4js/proj4js) (MIT). Their licences are in
  [`vendor/licenses`](vendor/licenses). Depth labels use Open Sans
  ([licence](glyphs/LICENSE.txt)).
- **Maps and data:** each one's credit is shown on the chart while it is shown.

| Map or data | Credit | Terms |
|---|---|---|
| Seabed depths | GMRT, the Global Multi-Resolution Topography synthesis: Ryan et al. 2009, doi:10.1029/2008GC002332 | CC BY 4.0. Not to be used for navigation |
| Dark and street basemaps | OpenFreeMap © OpenMapTiles, © OpenStreetMap contributors | Open data (ODbL). Not offered for saving offline |
| OpenStreetMap | © OpenStreetMap contributors | ODbL. Not offered for saving offline |
| OpenTopoMap | © OpenStreetMap contributors, SRTM, OpenTopoMap | CC-BY-SA. Asks for no bulk downloads |
| USGS Imagery | USGS The National Map | US public domain |
| Sentinel-2 satellite | Sentinel-2 cloudless, https://s2maps.eu, by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): non-commercial use, keep the credit. The one map offered for saving offline |
| Latest true colour | NASA Global Imagery Browse Services (GIBS) | NASA data, credit requested |

A map you add by your own link, and any file you load, is used under its owner's terms: that
is between you and them.
