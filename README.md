# OPERA DISP Portal

> 🚧 **In development** — not an official OPERA, JPL or NASA product.

**▶ <https://mgovorcin.github.io/disp-portal-dev/>**

A web viewer for [OPERA](https://www.jpl.nasa.gov/go/opera/) DISP-S1 surface displacement over North
America, built on [GeoLibre](https://github.com/opengeos/GeoLibre).

![Velocity overview](docs/img/velocity-overview.jpg)

- **Velocity overview** — ascending / descending line-of-sight velocity.
- **Time series** — turn on *Time-series mode* (📈) and click the map; fit trends, seasonal terms
  and steps; style the plot; export PNG or CSV.
- **Context** — search, draw, annotate, add your own layers; demo with roads, geology and 3D buildings.

## Run locally

Full-resolution overview, identify, analysis and downloads need the local server:

```bash
pixi run build-viewer   # once: bundle GeoLibre with the plugin
pixi run server         # http://localhost:8790
```

More in [docs/](docs/local-setup.md): [plugin](docs/plugin.md),
[downloads and products](docs/downloads-and-products.md), [GitHub Pages build](docs/github-pages.md).

## License and credits

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); release under JPL review.
AI assistance is noted in [AI_PROVENANCE.md](AI_PROVENANCE.md). Built with:

- [GeoLibre](https://github.com/opengeos/GeoLibre) (MIT, © Qiusheng Wu): the web GIS this plugin runs in.
- OPERA DISP-S1 products and time-series service: [ASF DAAC](https://asf.alaska.edu/) /
  [NASA Earthdata](https://www.earthdata.nasa.gov/); [opera-utils](https://github.com/opera-adt/opera-utils).
- Demo layers: [Overture Maps](https://overturemaps.org/) (roads, buildings; ODbL / CDLA),
  USGS [State Geologic Map Compilation](https://mrdata.usgs.gov/geology/state/) (WMS).
- Basemaps: [OpenFreeMap](https://openfreemap.org/), © OpenStreetMap contributors,
  Sentinel-2 cloudless by [EOX](https://s2maps.eu/).
- The OPERA logo belongs to the OPERA project (JPL); used here only to identify the data source.
