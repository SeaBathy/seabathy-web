# SeaBathy web app

**See what's under the boat, on an iPhone.** Your depth charts and surveys, satellite maps and
waypoints, working with no signal. It runs in the browser and installs from Safari to the Home
Screen, so it needs no App Store. It also works on Android and on a computer.

> **Not for navigation.** SeaBathy is not a nautical chart and must not be used for navigation.
> Its data comes from public sources and from the files you load, and can be wrong or out of
> date. Use official charts and proper navigation equipment. See the
> [terms of use](https://seabathy.com/terms).

This is the web version of [SeaBathy](https://seabathy.com). The Android and Windows apps do
more (3D, tides, sea conditions, routes, tracks, anchor alarm); this one covers the core: charts,
depth colours, satellite, waypoints and GPS.

## Contents

- [Install on an iPhone or iPad](#install-on-an-iphone-or-ipad)
- [Load your charts](#load-your-charts)
- [What it does](#what-it-does)
- [What an iPhone web app can't do](#what-an-iphone-web-app-cant-do)
- [Storage on the phone](#storage-on-the-phone)
- [Making charts](#making-charts)
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

Install first, then load your charts. Safari and the installed app keep their data apart, so
charts and waypoints you add in Safari do not appear in the installed app.

Needs iOS 15.2 or newer. On Android, open the address in Chrome and choose **Install app**.

## Load your charts

1. Copy the chart to the phone's **Files** app (AirDrop, iCloud Drive, a cable or a download).
2. In SeaBathy: menu (☰) → **Charts** → **Load a file from this phone**, and pick it.
3. The file is copied into the app and the chart flies to it. From then on it works offline.

| File | What it is |
|---|---|
| `.pmtiles` | A chart pack: depth shapes, contour lines, depth grids or chart pictures |
| `.tif` | A GeoTIFF depth survey, in longitude and latitude or in a projection such as UTM or MGA |

While a file loads, the phone needs free space of about twice its size. Keep the original
file as your backup. One very large chart is the least proven part of a web app on an iPhone:
charts cut into regions are the safer choice.

You can also read a PMTiles chart straight from a web address (**Charts** → *Or read a PMTiles
chart from a web address*). It then needs the internet, unless you save the area you want with
**Save for offline**.

## What it does

- **Charts:** PMTiles files and GeoTIFF depth surveys, kept on the phone.
- **Depth colours:** seven palettes, your own depth range, ready-made ranges (reef, inshore,
  coastal, offshore), a fit-to-this-chart button, and relief shading on depth surveys.
- **Depth at the crosshair,** with the position in degrees and minutes.
- **Basemaps:** dark, street map, OpenStreetMap, OpenTopoMap, USGS imagery, your own tile
  link with its credit, or none.
- **Satellite picture** over the charts, with an opacity slider.
- **Waypoints:** add at the crosshair or by holding a finger on the chart; name, note, colour
  and symbol; search; saved on the phone.
- **GPX in and out,** to back up waypoints and to move them between SeaBathy, a plotter and
  other apps.
- **GPS:** the boat on the chart with speed, course and accuracy, and a follow mode.
- **Save for offline:** the satellite picture or a web chart for the area on screen.
- **Storage:** how much the app is using, and a delete button for every chart and saved area.

## What an iPhone web app can't do

- **No GPS with the screen locked.** The position stops when the phone locks or another app is
  in front, so there is no track recording in a pocket and no overnight anchor alarm.
- **The phone may ask for location permission again** on later launches.
- **MBTiles files don't load.** Convert them to PMTiles first (see below).
- **Installing is by hand,** from Safari. There is no App Store listing.

## Storage on the phone

Everything is kept inside the app on the phone: charts in its private file storage, waypoints,
settings and saved map tiles in its database. An iPhone lets an installed web app use up to
about 60% of the phone's storage.

- The app asks the phone to keep its data. iOS decides, and is more likely to agree for an app
  on the Home Screen. **Storage** in the menu shows the answer.
- Without that promise, iOS may clear the data if the phone runs very short of space.
- Removing the app from the Home Screen deletes its data.

So keep your original chart files, and export your waypoints as GPX now and then.

## Making charts

**From MBTiles:** on a computer, with the free
[`pmtiles` tool](https://github.com/protomaps/go-pmtiles/releases):

```bash
pmtiles convert chart.mbtiles chart.pmtiles
```

**Depth shapes and contours** are coloured by a number on each shape. The app looks for a
field called `depth`, `contour`, `elevation` or similar, and works out whether depths are
written as positive numbers. If it picks the wrong one, choose the field under the chart's
settings.

**A chart on the web** must be served over HTTPS by a server that answers part-file (range)
requests and allows other sites to read it (CORS). Object storage such as Cloudflare R2 does
both. GitHub Pages is not suitable for charts: it limits a site to 1 GB.

## Publishing the app

The app is plain files with no build step, so any static host works. On GitHub Pages:

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder
   `/ (root)`.
3. Wait a minute, then open the address Pages gives you.

**Choose the final address before anyone uses it.** A phone ties saved charts and waypoints to
the app's web address. If the address changes later (a new domain, a renamed repository),
everyone starts again with an empty app.

**When you change any file,** raise `VERSION` in `sw.js` (and in `js/install.js`). That is
what makes phones fetch the new copy; they offer it with a "new version is ready" bar.

## Development and tests

```bash
npm install
npx playwright install webkit chromium
npm test
```

`npm test` serves the app over HTTPS on this computer and drives it in WebKit (Safari's
engine) set up as an iPhone: first start, offline reload, a PMTiles chart, GeoTIFF surveys,
waypoints, GPX, GPS, a web chart, saving an area, a restart and deleting a chart.
`ENGINE=chromium npm test` runs the same steps in Chromium. `npm run serve` just serves the
app at `https://localhost:8443/`. The test files (a small chart and two surveys) are made by
the tests themselves.

**WebKit on Windows is a cut-down build.** It can't write to private file storage, and with a
profile kept on disk it is very slow and its service worker never finishes installing. So on
Windows the WebKit tests use a private window and leave out three checks: a chart copied into
the app's storage, a restart, and deleting a chart. Chromium runs those on Windows. WebKit on
Linux and on a Mac runs every check, and the Playwright container does that from any computer:

```bash
docker run --rm --ipc=host -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.65.1-noble npm test
```

Every push to GitHub also runs the tests in WebKit on a Mac (`.github/workflows/test.yml`).

WebKit on a computer is still not an iPhone. The file picker, the Home Screen install, storage
limits and real GPS can only be checked on a phone.

| Folder | What's in it |
|---|---|
| `js/` | The app: `app.js` starts it; `charts.js`, `survey.js` and `depth.js` draw charts; `basemap.js`, `waypoints.js`, `gps.js`, `offline.js`, `files.js`, `db.js` are what their names say |
| `vendor/` | MapLibre GL JS, PMTiles, geotiff.js and proj4js, as released, with their licences |
| `glyphs/` | Lettering for depth labels, kept with the app so labels work offline |
| `sw.js` | Keeps the app's own files on the phone for offline use |
| `tests/` | The tests and their small HTTPS server |

## Privacy

SeaBathy has no accounts, ads or analytics, and sends nothing to this project. Your position,
waypoints and charts stay on your phone. When you use an online map, or a chart at a web
address, your phone asks that service directly, so it sees your internet address and the area
you asked for. One more request can happen: a survey in an unusual map projection makes the
app ask [epsg.io](https://epsg.io) once for that projection's definition, by its number.

## Credits and licence

- **Code:** GNU GPL-3.0, see [LICENSE](LICENSE).
- **Libraries:** [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) and
  [PMTiles](https://github.com/protomaps/PMTiles) (BSD 3-Clause),
  [geotiff.js](https://github.com/geotiffjs/geotiff.js) and
  [proj4js](https://github.com/proj4js/proj4js) (MIT). Their licences are in
  [`vendor/licenses`](vendor/licenses). Depth labels use Open Sans
  ([licence](glyphs/LICENSE.txt)).
- **Maps:** each map's credit is shown on the chart while it is shown.

| Map | Credit | Terms |
|---|---|---|
| Dark and street basemaps | OpenFreeMap © OpenMapTiles, © OpenStreetMap contributors | Open data (ODbL). Not offered for saving offline |
| OpenStreetMap | © OpenStreetMap contributors | ODbL. Not offered for saving offline |
| OpenTopoMap | © OpenStreetMap contributors, SRTM, OpenTopoMap | CC-BY-SA. Asks for no bulk downloads |
| USGS Imagery | USGS The National Map | US public domain |
| Sentinel-2 satellite | Sentinel-2 cloudless, https://s2maps.eu, by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): non-commercial use, keep the credit. The one map offered for saving offline |
| Latest true colour | NASA Global Imagery Browse Services (GIBS) | NASA data, credit requested |

A map you add by your own link, and any chart you load, is used under its owner's terms:
that is between you and them.
