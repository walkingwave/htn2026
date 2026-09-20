# The logo face

The wordmark is set in **Ping Pong** — drawn by Elżbieta Krużyńska in 1974,
digitised and extended by Mateusz Machalski and Małgorzata Bartosik in 2020,
published by [Capitalics](https://capitalics.wtf/en/font/ping-pong).

The file is not in this repository. It is free of charge but sits behind an
account on the foundry's site, so it has to be fetched by a person who has
agreed to the licence rather than pulled down by a build:

1. Sign in at <https://capitalics.wtf/en/font/ping-pong> and download it.
2. Read the licence on their site and check it covers what you are doing with
   it — a hackathon demo and a public deployment are not the same thing.
3. Convert to WOFF2 if the download doesn't include one (`fonttools`:
   `pyftsubset PingPong.otf --flavor=woff2 --output-file=PingPong.woff2`,
   or any web font converter).
4. Drop it here as `PingPong.woff2`.

That is all — `src/ui.css` already declares the `@font-face` and the title
picks it up on the next reload.

Without the file the logo falls back to the interface's monospace face. That
is deliberate: the app should look intentional to anyone who clones it, not
broken because an asset they cannot legally redistribute is missing.
